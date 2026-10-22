"""Точка входа для хостинга, который работает без этого компьютера.

Локально сайт по-прежнему запускается через server.py.
На хостинге файл должен отдавать объект application.
"""

import io
from http.server import BaseHTTPRequestHandler

import server


class HeaderBag:
    def __init__(self, pairs):
        self._values = {}
        for key, value in pairs:
            self._values[key.lower()] = value

    def get(self, name, default=None):
        return self._values.get(name.lower(), default)


def headers_from_environ(environ):
    pairs = []
    for key, value in environ.items():
        if not key.startswith("HTTP_"):
            continue
        name = key[5:].replace("_", "-")
        pairs.append((name, value))
    if environ.get("CONTENT_TYPE"):
        pairs.append(("Content-Type", environ["CONTENT_TYPE"]))
    if environ.get("CONTENT_LENGTH"):
        pairs.append(("Content-Length", str(environ["CONTENT_LENGTH"])))
    return HeaderBag(pairs)


def wsgi_app(environ, start_response):
    handler = server.Handler.__new__(server.Handler)
    method = environ.get("REQUEST_METHOD", "GET").upper()
    path = environ.get("PATH_INFO") or "/"
    query = environ.get("QUERY_STRING") or ""
    handler.command = method
    handler.path = path if not query else path + "?" + query
    handler.request_version = "HTTP/1.1"
    handler.requestline = "%s %s HTTP/1.1" % (method, handler.path)
    handler.protocol_version = "HTTP/1.1"
    handler.client_address = (environ.get("REMOTE_ADDR", ""), 0)
    handler.server = None
    handler.headers = headers_from_environ(environ)
    handler.rfile = environ["wsgi.input"]
    handler.wfile = io.BytesIO()
    handler.close_connection = True
    captured = {"status": "500 Internal Server Error", "headers": []}

    def send_response(code, message=None):
        if message is None:
            try:
                message = BaseHTTPRequestHandler.responses[int(code)][0]
            except (KeyError, TypeError, ValueError):
                message = "Error"
        captured["status"] = "%s %s" % (int(code), message)
        handler.log_request(code)

    def send_header(key, value):
        captured["headers"].append((str(key), str(value)))

    def end_headers():
        return None

    handler.send_response = send_response
    handler.send_header = send_header
    handler.end_headers = end_headers

    try:
        if method == "GET":
            handler.do_GET()
        elif method == "POST":
            handler.do_POST()
        elif method == "PATCH":
            handler.do_PATCH()
        else:
            handler.send_error(405)
    except Exception:
        server.traceback.print_exc()
        if not handler.wfile.getvalue():
            body = b'{"error":"Internal error"}'
            captured["status"] = "500 Internal Server Error"
            captured["headers"] = [
                ("Content-Type", "application/json; charset=utf-8"),
                ("Content-Length", str(len(body))),
                ("Cache-Control", "no-store"),
            ]
            handler.wfile.write(body)

    hop = {
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailers", "transfer-encoding", "upgrade",
    }
    headers = [(key, value) for key, value in captured["headers"] if key.lower() not in hop]
    start_response(captured["status"], headers)
    return [handler.wfile.getvalue()]


server.init_db()
application = wsgi_app
