# -*- coding: utf-8 -*-
"""
BrowserInterceptor — 浏览器内核级网络拦截器

核心原理:
  Playwright 启动 Chromium → 通过 CDP 启用 Network.enable
  → 监听 Network.responseReceived → URL 匹配 → Network.getResponseBody 获取响应体
  → 自动解析 JSON → 回调/输出

用法:
  # 函数式（简单场景）
  data = intercept_browser("https://quote.eastmoney.com/", filters=["push2.", "datacenter"], timeout=8)

  # 类（精细控制）
  with BrowserInterceptor() as b:
      b.set_filters(["*stock*"])
      b.start("https://quote.eastmoney.com/sz300604.html")
      time.sleep(5)
      data = b.flush()

  # CLI
  python browser_interceptor.py https://quote.eastmoney.com/ --filters push2.,datacenter --timeout 8 --output result.json

未来扩展方向:
  - 响应体捕获增强
  - 请求拦截+修改
  - WebSocket 拦截
  - DOM 变化监听
  - Cookie/LocalStorage 提取
  - 多页面统一监听
  - 内置分析器
  - 插件体系
  - 输出格式 (CSV/Excel/DB)
"""

import json
import time
import re
import argparse
import sys
import logging
from typing import List, Dict, Optional, Callable, Union
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

# ============================================================
# 数据结构
# ============================================================

@dataclass
class InterceptedRequest:
    """一次被拦截的网络请求"""
    request_id: str
    url: str
    status: int
    mime_type: str
    headers: dict
    body: Optional[Union[dict, str]] = None
    body_length: int = 0
    timestamp: float = 0.0
    error: Optional[str] = None


# ============================================================
# 过滤规则
# ============================================================
class URLFilter:
    """URL 过滤规则，自动识别数据源模式"""

    # 域名→拦截模式映射
    MODE_MAP = {
        'eastmoney.com': {'mode': 'auto', 'encoding': 'utf-8', 'data_type': 'jsonp'},
        'gtimg.cn': {'mode': 'route', 'encoding': 'gbk', 'data_type': 'auto'},
        'sqt.gtimg.cn': {'mode': 'route', 'encoding': 'gbk', 'data_type': 'json'},
        'web.sqt.gtimg.cn': {'mode': 'cdp', 'encoding': 'utf-8', 'data_type': 'text'},
        'qt.gtimg.cn': {'mode': 'route', 'encoding': 'gbk', 'data_type': 'text'},
        'push2.eastmoney.com': {'mode': 'auto', 'encoding': 'utf-8', 'data_type': 'jsonp'},
        'datacenter.eastmoney.com': {'mode': 'auto', 'encoding': 'utf-8', 'data_type': 'jsonp'},
        'datacenter-web.eastmoney.com': {'mode': 'auto', 'encoding': 'utf-8', 'data_type': 'jsonp'},
    }

    def __init__(self, pattern: str):
        if pattern.startswith('re:'):
            self._regex = re.compile(pattern[3:])
        else:
            escaped = re.escape(pattern).replace('\*', '.*')
            self._regex = re.compile(escaped, re.IGNORECASE)

        # 自动匹配拦截模式
        mode_info = self._detect_mode(pattern)
        self.match_mode = mode_info['mode']
        self.encoding = mode_info['encoding']
        self.data_type = mode_info['data_type']

    def _detect_mode(self, pattern: str) -> dict:
        """根据 URL 模式自动匹配拦截方式和编码"""
        # 按域名长度降序，长域名优先匹配
        sorted_domains = sorted(self.MODE_MAP.keys(), key=len, reverse=True)
        for domain in sorted_domains:
            if domain in pattern:
                return self.MODE_MAP[domain]
        return {'mode': 'auto', 'encoding': 'auto', 'data_type': 'auto'}

    def match(self, url: str) -> bool:
        return bool(self._regex.search(url))


# ===

# ============================================================
# BrowserInterceptor 类
# ============================================================

class BrowserInterceptor:
    """浏览器网络拦截器 — 支持 CDP + Route 双模式"""

    def __init__(self, headless: bool = False, user_data_dir: Optional[str] = None, page=None):
        self._headless = headless
        self._user_data_dir = user_data_dir
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = page  # 可选：传入已有 Page 对象
        self._cdp = None
        self._started = False
        self._enabled = False

        # 过滤规则 & 数据缓冲区
        self._filters: List[URLFilter] = []
        self._collected: List[InterceptedRequest] = []
        self._pending: Dict[str, InterceptedRequest] = {}
        self._max_buffer = 500
        self._on_data_callbacks: List[Callable] = []
        self._route_bodies: List[InterceptedRequest] = []

    # ---- 拦截器接口 ----

    def intercept_fetch(self, filter: List[str] = None):
        """
        拦截 fetch 请求
        filter: 域名过滤列表，如 ["gtimg", "push2.eastmoney"]
        """
        if filter:
            for f in filter:
                self.add_filter(f)
        self._enable_network()

    def intercept_xhr(self, filter: List[str] = None):
        """
        拦截 XHR 请求
        filter: 域名过滤列表，如 ["gtimg", "push2.eastmoney"]
        """
        if filter:
            for f in filter:
                self.add_filter(f)
        self._enable_network()
    # ---- 前置条件: Playwright 启动 ----

    def _ensure_browser(self):
        """确保 Playwright Chromium 已启动"""
        if self._page and self._cdp:
            return
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise ImportError("需要安装 playwright: pip install playwright && playwright install chromium")

        pw = sync_playwright().start()
        self._playwright = pw

        if self._user_data_dir:
            self._context = pw.chromium.launch_persistent_context(
                user_data_dir=self._user_data_dir,
                headless=self._headless,
            )
            self._page = self._context.pages[0] if self._context.pages else self._context.new_page()
        else:
            # 临时浏览器模式
            self._browser = pw.chromium.launch(headless=self._headless)
            self._context = self._browser
            self._page = self._browser.new_page()

        # 获取 CDP session
        self._cdp = self._page.context.new_cdp_session(self._page)

    # ---- 过滤规则 ----

    def add_filter(self, pattern: str):
        """添加 URL 过滤规则
        支持: "push2.eastmoney.com"（通配符号匹配）
              或 "re:pattern.*"（正则）
        """
        self._filters.append(URLFilter(pattern))

    def set_filters(self, patterns: List[str]):
        """批量设置过滤规则"""
        self._filters = [URLFilter(p) for p in patterns]

    def add_eastmoney_filters(self):
        """一键添加东方财富常用 API 过滤器"""
        patterns = [
            'push2.eastmoney.com/api/qt/stock/get',
            'push2.eastmoney.com/api/qt/stock/trends2',
            'datacenter.eastmoney.com/api/data/v1/get',
            'push2his.eastmoney.com/api/qt/stock/kline/get',
            'emdata.eastmoney.com/fast_new_market',
            'push2.eastmoney.com/api/qt/slist/get',
            'datacenter-web.eastmoney.com/api/data/v1/get',
        ]
        for p in patterns:
            self.add_filter(p)

    def _enable_network(self):
        """启用网络拦截 — 根据过滤器自动选择 CDP 和/或 Route 模式"""
        if self._enabled:
            return
        self._ensure_browser()

        # 收集所有过滤器的模式需求
        modes_needed = set()
        for f in self._filters:
            modes_needed.add(f.match_mode)

        # 注册 CDP 事件监听（适合东方财富等长轮询）
        self._cdp.on('Network.responseReceived', lambda params: self._on_response_received(params))
        self._cdp.on('Network.loadingFinished', lambda params: self._on_loading_finished(params))
        self._cdp.send('Network.enable')
        logger.info(f"CDP Network.enable 已发送")

        # 注册 Route 拦截（适合腾讯等 GBK 编码的短轮询）
        need_route = 'route' in modes_needed or 'auto' in modes_needed
        if need_route:
            self._page.route('**/*', self._on_route)
            logger.info(f"Route 拦截已注册")

        self._enabled = True
        self._collected.clear()
        self._pending.clear()
        self._route_bodies.clear()

    def _on_route(self, route):
        """Route 拦截回调 — 获取 body 后原样放行"""
        url = route.request.url

        # 检查是否匹配过滤器
        matched = None
        for f in self._filters:
            if f.match(url):
                matched = f
                break

        if not matched:
            route.continue_()
            return

        try:
            response = route.fetch()
            body_bytes = response.body()

            # 根据编码解码
            enc = matched.encoding
            if enc == 'auto':
                # 自动探测编码
                try:
                    text = body_bytes.decode('utf-8')
                except UnicodeDecodeError:
                    text = body_bytes.decode('gbk', errors='replace')
            elif enc == 'gbk':
                text = body_bytes.decode('gbk', errors='replace')
            else:
                text = body_bytes.decode('utf-8', errors='replace')

            req = InterceptedRequest(
                request_id=f'route_{len(self._route_bodies)}',
                url=url,
                status=response.status,
                mime_type=response.headers.get('content-type', ''),
                headers=dict(response.headers),
                timestamp=time.time(),
                body_length=len(text),
            )

            # 解析 body
            text = text[:50000]
            stripped = text.lstrip()
            if stripped[:1] in ('{', '['):
                try:
                    req.body = json.loads(text)
                except json.JSONDecodeError:
                    req.body = text
            else:
                req.body = text

            self._route_bodies.append(req)

            for cb in self._on_data_callbacks:
                try:
                    cb(req)
                except Exception:
                    pass

            route.fulfill(response=response)
        except Exception as e:
            logger.debug(f"Route fetch error for {url[:60]}: {e}")
            route.continue_()
    def _match_url(self, url: str) -> bool:
        if not self._filters:
            return True
        for f in self._filters:
            if f.match(url):
                return True
        return False

    def _on_response_received(self, params: dict):
        """处理 Network.responseReceived"""
        rid = params.get('requestId', '')
        response = params.get('response', {})
        url = response.get('url', '')
        status = response.get('status', 0)

        if not self._match_url(url):
            return

        req = InterceptedRequest(
            request_id=rid,
            url=url,
            status=status,
            mime_type=response.get('mimeType', ''),
            headers=response.get('headers', {}),
            timestamp=time.time(),
        )
        self._pending[rid] = req

        # 日志
        logger.debug(f"[API] {status} {url[:100]}")

    def _on_loading_finished(self, params: dict):
        """处理 Network.loadingFinished → 获取响应体"""
        rid = params.get('requestId', '')
        req = self._pending.pop(rid, None)
        if not req:
            return

        try:
            result = self._cdp.send('Network.getResponseBody', {'requestId': rid})
            if result and 'result' in result:
                body = result['result'].get('body', '')
                if not body or len(body) < 20:
                    return
                req.body_length = len(body)
                # 尝试 JSON 解析
                if body.lstrip()[:1] in ('{', '['):
                    try:
                        req.body = json.loads(body)
                    except json.JSONDecodeError:
                        req.body = body[:50000]
                else:
                    req.body = body[:50000]
        except Exception as e:
            req.error = str(e)
            return

        self._collected.append(req)

        # 回调
        for cb in self._on_data_callbacks:
            try:
                cb(req)
            except Exception:
                pass

    def _poll_events(self, timeout: float):
        """等待事件处理完成（事件驱动模式，不需要轮询 recv）"""
        # Playwright CDP 事件是异步触发的，等待一段时间让事件到达
        import time
        time.sleep(timeout)
        self._flush_pending()

    def _flush_pending(self):
        """处理所有剩余的 pending 请求"""
        for rid, req in list(self._pending.items()):
            try:
                result = self._cdp.send('Network.getResponseBody', {'requestId': rid})
                if result:
                    body = result.get('body', '')
                    if isinstance(result, dict) and 'result' in result:
                        body = result['result'].get('body', '')
                    if body and len(body) >= 20:
                        req.body_length = len(body)
                        if body.lstrip()[:1] in ('{', '['):
                            try:
                                req.body = json.loads(body)
                            except json.JSONDecodeError:
                                req.body = body[:50000]
                        else:
                            req.body = body[:50000]
                        self._collected.append(req)
            except Exception:
                pass
        self._pending.clear()

    # ---- 对外接口 ----

    def start(self, url: str):
        """打开 URL 并启用网络拦截"""
        self._ensure_browser()
        self._enable_network()
        self._cdp.send('Page.navigate', {'url': url})
        self._started = True
        logger.info(f"已导航到: {url}")
        return self

    def wait(self, timeout: float = 5.0):
        """等待并收集网络数据"""
        if not self._started:
            raise RuntimeError("请先调用 start(url)")
        # 用 page.wait_for_load_state 驱动 Playwright 事件循环
        # 同时配合 time.sleep 确保所有事件被处理
        import time
        deadline = time.time() + timeout
        try:
            self._page.wait_for_load_state('networkidle', timeout=timeout * 1000)
        except Exception:
            pass
        # 再等一小段时间让剩余事件到达
        remaining = deadline - time.time()
        if remaining > 0:
            time.sleep(min(remaining, 2.0))
        self._flush_pending()
        return self

    def flush(self) -> List[Dict]:
        """获取已收集的拦截数据"""
    def flush(self) -> List[Dict]:
        """获取已收集的拦截数据 (CDP + Route)"""
        self._flush_pending()
        return [
            {
                'type': 'api',
                'url': r.url,
                'status': r.status,
                'body': r.body,
                'body_length': r.body_length,
                'error': r.error,
            }
            for r in self._collected + self._route_bodies
        ]

    # ---- 回调注册 ----

    def on_data(self, callback: Callable):
        """注册数据到达回调"""
        self._on_data_callbacks.append(callback)
    def flush_and_analyze(self, initial_url: str = None) -> dict:
        """获取数据并进行初步分析 + 异常信号检测"""
        data = self.flush()
        analysis = _analyze_intercepted_data(data, initial_url)
        anomaly_result = detect_all_anomalies(data)
        return {'data': data, 'analysis': analysis, 'anomalies': anomaly_result}

    def close(self):
        """关闭浏览器并释放资源"""
        self._started = False
        self._enabled = False
        self._cdp = None
        self._page = None
        if self._context:
            try:
                self._context.close()
            except Exception:
                pass
            self._context = None
        if self._browser:
            try:
                self._browser.close()
            except Exception:
                pass
            self._browser = None
        if self._playwright:
            try:
                self._playwright.stop()
            except Exception:
                pass
            self._playwright = None
        logger.info("浏览器已关闭")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


# ============================================================
# 异常信号检测
# ============================================================

MONITOR_DIMENSIONS = {
    'headers': {
        'desc': 'Headers Token 缺失/过期、UA 异常',
        'triggers': ['登录过期', '无权限', '浏览器不兼容'],
    },
    'payload': {
        'desc': '参数缺失、类型错误、非法字符',
        'triggers': ['参数校验失败', '后端解析崩溃'],
    },
    'status': {
        'desc': '4xx, 5xx 状态码',
        'triggers': ['业务错误', '服务器故障', '网络超时'],
    },
    'body': {
        'desc': '返回 null, [], 非 JSON 格式',
        'triggers': ['数据加载失败', 'JSON 解析错误'],
    },
    'time': {
        'desc': '耗时 > 阈值',
        'triggers': ['请求超时', '网络卡顿'],
    },
}


def detect_anomaly_signals(request: dict) -> dict:
    """对单个拦截请求进行 5 维度异常信号检测

    Args:
        request: flush() 返回的单个请求字典，包含 url, status, body, headers 等字段

    Returns:
        {
            'url': str,
            'signals': [{'dimension': 'headers', 'level': 'warning', 'reason': '...'}, ...],
            'alert': bool,  # True 表示有异常信号
            'severity': 'none' | 'low' | 'medium' | 'high'
        }
    """
    signals = []

    url = request.get('url', '')
    status = request.get('status', 200)
    body = request.get('body')
    headers = request.get('headers', {})
    # 暂未获取耗时，留空

    # --- 1. Headers 检测 ---
    if status == 401 or status == 403:
        signals.append({
            'dimension': 'headers',
            'level': 'high',
            'reason': f'状态码 {status} 通常由 Token 过期或无权限触发',
            'triggers': MONITOR_DIMENSIONS['headers']['triggers'],
        })
    elif status == 400:
        signals.append({
            'dimension': 'headers',
            'level': 'medium',
            'reason': '400 Bad Request 可能由 UA 异常或请求头格式错误导致',
            'triggers': ['浏览器不兼容', '请求头格式错误'],
        })

    # --- 2. Payload 检测 ---
    if status == 422:
        signals.append({
            'dimension': 'payload',
            'level': 'high',
            'reason': '422 Unprocessable Entity — 参数校验失败',
            'triggers': MONITOR_DIMENSIONS['payload']['triggers'],
        })
    elif status == 400:
        signals.append({
            'dimension': 'payload',
            'level': 'medium',
            'reason': '400 可能是参数缺失或类型错误',
            'triggers': ['参数缺失', '类型错误'],
        })

    # --- 3. Status 检测 ---
    if 400 <= status < 500:
        signals.append({
            'dimension': 'status',
            'level': 'high' if status in (401, 403, 404) else 'medium',
            'reason': f'{status} 客户端错误 — 可能是业务错误或无权限',
            'triggers': MONITOR_DIMENSIONS['status']['triggers'],
        })
    elif 500 <= status < 600:
        signals.append({
            'dimension': 'status',
            'level': 'high',
            'reason': f'{status} 服务端错误 — 服务器故障或网络异常',
            'triggers': MONITOR_DIMENSIONS['status']['triggers'],
        })

    # --- 4. Body 检测 ---
    # body 可能是 None、字符串、dict
    if body is None:
        signals.append({
            'dimension': 'body',
            'level': 'warning',
            'reason': '响应体为空 (None) — 数据加载可能失败',
            'triggers': ['数据加载失败', '响应体获取超时'],
        })
    elif isinstance(body, str):
        # 非 JSON 字符串：可能是错误信息
        body_lower = body.lower().strip()
        if not body_lower or body_lower == 'null' or body_lower == '[]':
            signals.append({
                'dimension': 'body',
                'level': 'warning',
                'reason': f'响应体为空值: {body[:50]}',
                'triggers': MONITOR_DIMENSIONS['body']['triggers'],
            })
        elif any(kw in body_lower for kw in ['error', 'fail', 'timeout', 'denied', 'invalid']):
            signals.append({
                'dimension': 'body',
                'level': 'high',
                'reason': f'返回文本包含错误关键字: {body[:100]}',
                'triggers': ['业务返回错误信息', '接口返回异常'],
            })
    elif isinstance(body, dict):
        # JSON 对象：检查常见错误字段
        error_keys = ['error', 'err', 'errcode', 'errmsg', 'message', 'msg', 'code', 'status']
        for ek in error_keys:
            if ek in body:
                val = body[ek]
                if val and (isinstance(val, str) and any(kw in str(val).lower() for kw in ['error', 'fail', 'timeout', 'denied', 'invalid', '-1', '1'])):
                    signals.append({
                        'dimension': 'body',
                        'level': 'high',
                        'reason': f'JSON 含错误字段 {ek}={str(val)[:60]}',
                        'triggers': MONITOR_DIMENSIONS['body']['triggers'],
                    })
                break
        # 检查 data/list/result 为空
        if not signals:
            for data_field in ['data', 'result', 'list', 'items', 'records']:
                if data_field in body:
                    val = body[data_field]
                    if val is None or (isinstance(val, (list, dict, str)) and len(val) == 0):
                        signals.append({
                            'dimension': 'body',
                            'level': 'warning',
                            'reason': f'JSON 中 {data_field} 字段为空',
                            'triggers': ['无数据返回', '查询条件无效'],
                        })
                    break

    # --- 汇总 ---
    has_alert = len(signals) > 0
    if not has_alert:
        return {
            'url': url,
            'signals': [],
            'alert': False,
            'severity': 'none',
        }

    # 严重级别: 取最高级
    level_order = {'warning': 0, 'low': 1, 'medium': 2, 'high': 3}
    max_level = max(signals, key=lambda s: level_order.get(s['level'], 0))['level']

    return {
        'url': url,
        'signals': signals,
        'alert': True,
        'severity': max_level,
    }


def detect_all_anomalies(data: List[Dict]) -> dict:
    """对全部拦截请求做批量异常信号检测

    Returns:
        {
            'total': int,           # 总请求数
            'alert_count': int,     # 有异常的请求数
            'alerts': [detect_anomaly_signals(d), ...],  # 仅包含有异常的结果
            'summary': {
                'high': int,        # 高风险数
                'medium': int,      # 中风险数
                'warning': int,     # 警告数
                'none': int,        # 无异常数
            },
            'top_triggers': [       # 最常见的异常原因
                {'reason': 'xxx', 'count': N},
            ]
        }
    """
    if not data:
        return {
            'total': 0,
            'alert_count': 0,
            'alerts': [],
            'summary': {'high': 0, 'medium': 0, 'warning': 0, 'none': 0},
            'top_triggers': [],
        }

    results = [detect_anomaly_signals(d) for d in data]
    alerts = [r for r in results if r['alert']]

    summary = {'high': 0, 'medium': 0, 'warning': 0, 'none': 0}
    for r in results:
        sev = r['severity']
        if sev in summary:
            summary[sev] += 1
        else:
            summary[sev] = 1

    # 统计高频原因
    from collections import Counter
    all_reasons = []
    for r in alerts:
        for s in r['signals']:
            all_reasons.append(s['reason'][:40])
    top_reasons = [{'reason': reason, 'count': cnt} for reason, cnt in Counter(all_reasons).most_common(10)]

    return {
        'total': len(data),
        'alert_count': len(alerts),
        'alerts': alerts,
        'summary': summary,
        'top_triggers': top_reasons,
    }


# ============================================================
# 分析函数
# ============================================================

def _analyze_intercepted_data(data: List[Dict], initial_url: str = None) -> dict:
    """分析拦截数据，判断页面状态"""
    if not data:
        return {
            'status': 'empty',
            'confidence': 0.0,
            'reason': '未拦截到任何网络请求',
            'details': [],
            'metrics': {'total_requests': 0, 'api_requests': 0, 'blocked_urls': []},
        }

    # 统计
    total = len(data)
    api_count = sum(1 for d in data if d.get('body'))
    errors = sum(1 for d in data if d.get('error'))
    json_count = sum(1 for d in data if isinstance(d.get('body'), dict))

    status = 'ok' if json_count > 0 else ('partial' if api_count > 0 else 'empty')
    confidence = min(1.0, json_count * 0.2) if json_count > 0 else 0.0

    return {
        'status': status,
        'confidence': confidence,
        'reason': f"拦截 {total} 请求, {api_count} 有数据, {json_count} 含 JSON" if json_count > 0 else '无有效 JSON 数据',
        'details': [{'url': d['url'][:80], 'has_body': bool(d.get('body'))} for d in data[:10]],
        'metrics': {
            'total_requests': total,
            'api_requests': api_count,
            'json_responses': json_count,
            'errors': errors,
            'blocked_urls': [],
        }
    }


# ============================================================
# 便捷函数
# ============================================================

def intercept_browser(
    url: str,
    filters: List[str] = None,
    headless: bool = True,
    timeout: float = 8.0,
    user_data_dir: str = None,
    on_data: Callable = None,
) -> dict:
    """一键启动浏览器拦截并返回数据

    用法:
        result = intercept_browser(
            "https://quote.eastmoney.com/sz300604.html",
            filters=["push2.eastmoney.com", "datacenter"],
            timeout=8
        )
        print(result['data'][:3])
        print(result['analysis'])
    """
    with BrowserInterceptor(headless=headless, user_data_dir=user_data_dir) as b:
        if filters:
            b.set_filters(filters)
        if on_data:
            b.on_data(on_data)
        b.start(url)
        b.wait(timeout=timeout)
        return b.flush_and_analyze(initial_url=url)


# ============================================================
# CLI 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description='BrowserInterceptor - 浏览器内核级网络拦截器',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python %(prog)s https://quote.eastmoney.com/ --filters push2.,datacenter
  python %(prog)s https://www.baidu.com --timeout 5 --output result.json
  python %(prog)s https://quote.eastmoney.com/ --eastmoney --headless
        """,
    )
    parser.add_argument('url', type=str, help='要拦截的页面 URL')
    parser.add_argument('--filters', '-f', type=str, nargs='*', default=None,
                        help='URL 过滤器（支持通配符 *）')
    parser.add_argument('--eastmoney', '-e', action='store_true',
                        help='使用东方财富预设过滤器')
    parser.add_argument('--timeout', '-t', type=float, default=8.0,
                        help='等待超时秒数 (默认: 8)')
    parser.add_argument('--headless', action='store_true', default=True,
                        help='无头模式 (默认开启)')
    parser.add_argument('--visible', action='store_false', dest='headless',
                        help='显示浏览器窗口')
    parser.add_argument('--output', '-o', type=str, default=None,
                        help='输出 JSON 文件路径')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='详细日志输出')
    parser.add_argument('--pretty', '-p', action='store_true',
                        help='JSON 输出缩进格式化')

    args = parser.parse_args()

    # 日志级别
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format='[%(levelname)s] %(message)s',
    )

    # 构建过滤器
    filters = list(args.filters) if args.filters else []
    if args.eastmoney:
        # 引用类方法添加东方财富过滤器
        tmp = BrowserInterceptor()
        tmp.add_eastmoney_filters()
        eastmoney_patterns = [f._regex.pattern for f in tmp._filters]

    logger.info(f"开始拦截: {args.url}")

    # 执行拦截
    try:
        result = intercept_browser(
            url=args.url,
            filters=filters or None,
            headless=args.headless,
            timeout=args.timeout,
        )
    except Exception as e:
        logger.error(f"拦截失败: {e}")
        sys.exit(1)

    # 输出
    total = len(result.get('data', []))
    analysis = result.get('analysis', {})
    anomalies = result.get('anomalies', {})
    status = analysis.get('status', 'unknown')
    alert_count = anomalies.get('alert_count', 0)

    logger.info(f"拦截完成: {total} 请求, 状态={status}, 异常信号={alert_count} 个")

    if result['data']:
        # 正常数据
        for item in result['data'][:5]:
            body_preview = ''
            if isinstance(item.get('body'), dict):
                body_preview = json.dumps(item['body'], ensure_ascii=False)[:200]
            elif isinstance(item.get('body'), str):
                body_preview = item['body'][:200]
            print(f"  [{item['status']}] {item['url'][:80]}")
            if body_preview:
                print(f"       {body_preview}")

        # 异常信号输出
        if alert_count > 0:
            print(f"\n⚠️ 检测到 {alert_count} 个异常信号:")
            for alert in anomalies.get('alerts', [])[:5]:
                print(f"  [{alert['severity'].upper()}] {alert['url'][:60]}")
                for s in alert['signals']:
                    print(f"     [{s['dimension']}] {s['reason'][:100]}")
            summary = anomalies.get('summary', {})
            print(f"\n异常汇总: high={summary.get('high',0)} medium={summary.get('medium',0)} warning={summary.get('warning',0)} none={summary.get('none',0)}")
            top = anomalies.get('top_triggers', [])
            if top:
                print(f"高频原因: {top[0]['reason'][:50]}({top[0]['count']})")

    # 输出到文件
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2 if args.pretty else None)
        logger.info(f"结果已保存: {args.output}")

    # 以 JSON 输出到 stdout（管道友好）
    if not sys.stdout.isatty():
        json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
