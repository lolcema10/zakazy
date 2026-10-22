#!/usr/bin/env python3
"""Кабинет заказов: регистрация, заказы и переписка.

Запуск: python3 server.py
Сайт:   http://127.0.0.1:8787

Первый зарегистрированный аккаунт становится владельцем.
Дальше клиенты регистрируются сами, оставляют заказы и пишут
владельцу внутри заказа.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import sqlite3
import sys
import threading
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DB_PATH = Path(os.environ.get("APP_DB", str(ROOT / "data" / "app.db"))).expanduser()
HOST = os.environ.get("APP_HOST", "0.0.0.0")
try:
    PORT = int(os.environ.get("PORT") or os.environ.get("APP_PORT") or "8787")
except ValueError:
    raise SystemExit("Порт должен быть числом")

ITERATIONS = 120_000
SESSION_TTL = 60 * 60 * 24 * 30
STATUSES = ("new", "work", "done", "cancelled")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DB_LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'client')),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('new', 'work', 'done', 'cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);
CREATE INDEX IF NOT EXISTS idx_orders_updated ON orders(updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
"""

ORDER_SELECT = """
SELECT
    o.id, o.client_id, o.title, o.description, o.status, o.created_at, o.updated_at,
    u.name AS client_name, u.email AS client_email
FROM orders o
JOIN users u ON u.id = o.client_id
"""

LIST_SELECT = """
SELECT
    o.id, o.client_id, o.title, o.description, o.status, o.created_at, o.updated_at,
    u.name AS client_name, u.email AS client_email,
    lm.body AS last_message,
    lm.author_id AS last_author_id,
    au.name AS last_author_name
FROM orders o
JOIN users u ON u.id = o.client_id
LEFT JOIN messages lm ON lm.id = (
    SELECT m.id FROM messages m WHERE m.order_id = o.id ORDER BY m.id DESC LIMIT 1
)
LEFT JOIN users au ON au.id = lm.author_id
"""

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
}


class HttpError(Exception):
    def __init__(self, code, message):
        self.code = code
        self.message = message


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    return f"pbkdf2_sha256${ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password, stored):
    try:
        algo, rounds_text, salt_hex, hash_hex = stored.split("$")
        rounds = int(rounds_text)
        if algo != "pbkdf2_sha256" or rounds < 1 or rounds > 500_000:
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            rounds,
        )
        return hmac.compare_digest(digest.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


DUMMY_HASH = hash_password("not-a-real-password")


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA journal_mode = WAL")


def db(fn):
    with DB_LOCK:
        conn = sqlite3.connect(DB_PATH, timeout=15)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            result = fn(conn)
            conn.commit()
            return result
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def require_text(value, min_len, max_len, empty, long):
    if not isinstance(value, str):
        raise HttpError(400, empty)
    text = value.strip()
    if len(text) < min_len:
        raise HttpError(400, empty)
    if len(text) > max_len:
        raise HttpError(400, long)
    if "\x00" in text:
        raise HttpError(400, "Некорректный текст")
    return text


def clean_email(value):
    if not isinstance(value, str):
        raise HttpError(400, "Введите почту")
    email = value.strip().lower()
    if len(email) > 200 or not EMAIL_RE.match(email):
        raise HttpError(400, "Почта выглядит неверно")
    return email


def clean_password(value):
    if not isinstance(value, str) or len(value) < 6:
        raise HttpError(400, "Пароль должен быть не короче 6 символов")
    if len(value) > 200:
        raise HttpError(400, "Слишком длинный пароль")
    return value


def public_user(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "role": row["role"],
    }


def order_json(row, viewer):
    data = {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "clientName": row["client_name"],
    }
    if viewer["role"] == "owner":
        data["clientEmail"] = row["client_email"]
    if "last_message" in row.keys():
        data["lastMessage"] = row["last_message"]
        data["lastAuthorId"] = row["last_author_id"]
        data["lastAuthorName"] = row["last_author_name"]
    return data


def message_json(row):
    return {
        "id": row["id"],
        "body": row["body"],
        "createdAt": row["created_at"],
        "authorId": row["author_id"],
        "authorName": row["author_name"],
        "authorRole": row["author_role"],
    }


def session_cookie(token, max_age):
    return "; ".join([
        f"session={token}",
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        f"Max-Age={max_age}",
    ])


def new_session(conn, user_id):
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
        (token, user_id, now_iso()),
    )
    return token


def find_user(conn, handler):
    token = handler.read_cookie("session")
    if not token or len(token) > 200:
        return None
    return conn.execute(
        """
        SELECT u.id, u.name, u.email, u.role
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ?
        """,
        (token,),
    ).fetchone()


def require_user(conn, handler):
    user = find_user(conn, handler)
    if user is None:
        raise HttpError(401, "Нужно войти")
    return user


def fetch_order(conn, order_id):
    return conn.execute(ORDER_SELECT + " WHERE o.id = ?", (order_id,)).fetchone()


def can_see(user, order):
    return order is not None and (user["role"] == "owner" or order["client_id"] == user["id"])


def register(conn, body):
    name = require_text(
        body.get("name"), 2, 80,
        "Введите имя — хотя бы 2 буквы",
        "Имя слишком длинное",
    )
    email = clean_email(body.get("email"))
    password = clean_password(body.get("password"))
    count = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    role = "owner" if count == 0 else "client"
    try:
        cur = conn.execute(
            """
            INSERT INTO users (name, email, password_hash, role, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (name, email, hash_password(password), role, now_iso()),
        )
    except sqlite3.IntegrityError:
        raise HttpError(409, "Такая почта уже зарегистрирована")
    user = conn.execute(
        "SELECT id, name, email, role FROM users WHERE id = ?",
        (cur.lastrowid,),
    ).fetchone()
    token = new_session(conn, user["id"])
    return 200, {"user": public_user(user)}, [session_cookie(token, SESSION_TTL)]


def login(conn, body):
    raw_email = body.get("email")
    password = body.get("password")
    email = raw_email.strip().lower() if isinstance(raw_email, str) else ""
    if not isinstance(password, str):
        password = ""
    user = None
    if email and len(email) <= 200 and EMAIL_RE.match(email):
        user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    stored = user["password_hash"] if user is not None else DUMMY_HASH
    if user is None or not verify_password(password, stored):
        raise HttpError(400, "Неверная почта или пароль")
    token = new_session(conn, user["id"])
    return 200, {"user": public_user(user)}, [session_cookie(token, SESSION_TTL)]


def logout(conn, handler):
    token = handler.read_cookie("session")
    if token:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    return 200, {"ok": True}, [session_cookie("", 0)]


def list_orders(conn, user):
    if user["role"] == "owner":
        rows = conn.execute(LIST_SELECT + " ORDER BY o.updated_at DESC LIMIT 200").fetchall()
    else:
        rows = conn.execute(
            LIST_SELECT + " WHERE o.client_id = ? ORDER BY o.updated_at DESC LIMIT 200",
            (user["id"],),
        ).fetchall()
    return [order_json(row, user) for row in rows]


def create_order(conn, user, body):
    if user["role"] != "client":
        raise HttpError(403, "Заказ создаёт клиент")
    title = require_text(
        body.get("title"), 2, 140,
        "Введите название заказа",
        "Название слишком длинное",
    )
    description = require_text(
        body.get("description"), 1, 4000,
        "Опишите, что нужно сделать",
        "Описание слишком длинное",
    )
    ts = now_iso()
    cur = conn.execute(
        """
        INSERT INTO orders (client_id, title, description, status, created_at, updated_at)
        VALUES (?, ?, ?, 'new', ?, ?)
        """,
        (user["id"], title, description, ts, ts),
    )
    order = fetch_order(conn, cur.lastrowid)
    return 200, {"order": order_json(order, user)}, None


def update_status(conn, user, order_id, body):
    if user["role"] != "owner":
        raise HttpError(403, "Статус меняет владелец")
    order = fetch_order(conn, order_id)
    if order is None:
        raise HttpError(404, "Заказ не найден")
    status = body.get("status")
    if status not in STATUSES:
        raise HttpError(400, "Неизвестный статус")
    conn.execute(
        "UPDATE orders SET status = ?, updated_at = ? WHERE id = ?",
        (status, now_iso(), order_id),
    )
    updated = fetch_order(conn, order_id)
    return 200, {"order": order_json(updated, user)}, None


def add_message(conn, user, order_id, body):
    order = fetch_order(conn, order_id)
    if not can_see(user, order):
        raise HttpError(404, "Заказ не найден")
    text = require_text(
        body.get("body"), 1, 4000,
        "Напишите сообщение",
        "Сообщение слишком длинное",
    )
    ts = now_iso()
    cur = conn.execute(
        """
        INSERT INTO messages (order_id, author_id, body, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (order_id, user["id"], text, ts),
    )
    conn.execute("UPDATE orders SET updated_at = ? WHERE id = ?", (ts, order_id))
    row = conn.execute(
        """
        SELECT m.id, m.body, m.created_at, m.author_id, u.name AS author_name, u.role AS author_role
        FROM messages m
        JOIN users u ON u.id = m.author_id
        WHERE m.id = ?
        """,
        (cur.lastrowid,),
    ).fetchone()
    return 200, {"message": message_json(row)}, None


def order_payload(conn, user, order_id, after):
    order = fetch_order(conn, order_id)
    if not can_see(user, order):
        raise HttpError(404, "Заказ не найден")
    rows = conn.execute(
        """
        SELECT m.id, m.body, m.created_at, m.author_id, u.name AS author_name, u.role AS author_role
        FROM messages m
        JOIN users u ON u.id = m.author_id
        WHERE m.order_id = ? AND m.id > ?
        ORDER BY m.id ASC
        """,
        (order_id, after),
    ).fetchall()
    return {"order": order_json(order, user), "messages": [message_json(row) for row in rows]}


def parse_id(text):
    if not str(text).isdigit() or len(str(text)) > 12:
        raise HttpError(404, "Заказ не найден")
    return int(text)


def parse_after(qs):
    raw = (qs.get("after") or ["0"])[0]
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return 0


def lan_ip():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def site_urls():
    local = f"http://127.0.0.1:{PORT}"
    ip = lan_ip()
    if HOST not in ("0.0.0.0", "::") or not ip or ip.startswith("127."):
        return local, None
    return local, f"http://{ip}:{PORT}"


class Handler(BaseHTTPRequestHandler):
    server_version = "Orders/1.0"

    def read_cookie(self, name):
        prefix = name + "="
        for part in self.headers.get("Cookie", "").split(";"):
            part = part.strip()
            if part.startswith(prefix):
                return part[len(prefix):]
        return ""

    def check_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return
        host = self.headers.get("Host", "")
        if origin not in (f"http://{host}", f"https://{host}"):
            raise HttpError(403, "Запрос отклонён")

    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            raise HttpError(400, "Некорректный запрос")
        if length < 0 or length > 100_000:
            raise HttpError(413, "Слишком большой запрос")
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HttpError(400, "Некорректный запрос")
        if not isinstance(data, dict):
            raise HttpError(400, "Некорректный запрос")
        return data

    def send_json(self, code, payload, cookies=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for cookie in cookies or []:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def dispatch(self, conn, method, parts, qs, body):
        if parts == ["api", "meta"] and method == "GET":
            local, lan = site_urls()
            count = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
            return 200, {
                "needsOwner": count == 0,
                "localUrl": local,
                "lanUrl": lan,
            }, None

        if parts == ["api", "register"] and method == "POST":
            return register(conn, body)
        if parts == ["api", "login"] and method == "POST":
            return login(conn, body)
        if parts == ["api", "logout"] and method == "POST":
            return logout(conn, self)
        if parts == ["api", "me"] and method == "GET":
            user = find_user(conn, self)
            return 200, {"user": None if user is None else public_user(user)}, None
        if parts == ["api", "orders"] and method == "GET":
            return 200, {"orders": list_orders(conn, require_user(conn, self))}, None
        if parts == ["api", "orders"] and method == "POST":
            return create_order(conn, require_user(conn, self), body)
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "orders" and method == "GET":
            user = require_user(conn, self)
            return 200, order_payload(conn, user, parse_id(parts[2]), parse_after(qs)), None
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "orders" and method == "PATCH":
            user = require_user(conn, self)
            return update_status(conn, user, parse_id(parts[2]), body)
        if (
            len(parts) == 4
            and parts[0] == "api"
            and parts[1] == "orders"
            and parts[3] == "messages"
            and method == "POST"
        ):
            user = require_user(conn, self)
            return add_message(conn, user, parse_id(parts[2]), body)
        raise HttpError(404, "Не найдено")

    def handle_api(self):
        parsed = urlparse(self.path)
        parts = [part for part in parsed.path.split("/") if part]
        try:
            body = {}
            if self.command in ("POST", "PATCH"):
                self.check_origin()
                body = self.read_body()
            code, payload, cookies = db(
                lambda conn: self.dispatch(conn, self.command, parts, parse_qs(parsed.query), body)
            )
            self.send_json(code, payload, cookies)
        except HttpError as err:
            self.send_json(err.code, {"error": err.message})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            traceback.print_exc()
            try:
                self.send_json(500, {"error": "Внутренняя ошибка"})
            except (BrokenPipeError, ConnectionResetError):
                return

    def serve_static(self):
        raw = urlparse(self.path).path
        rel = "index.html" if raw in ("", "/") else raw.lstrip("/")
        if "\\" in rel or ".." in Path(rel).parts:
            self.send_error(404)
            return
        root = STATIC.resolve()
        file = (root / rel).resolve()
        if file != root and root not in file.parents:
            self.send_error(404)
            return
        if file.is_dir():
            file = file / "index.html"
        if not file.is_file():
            self.send_error(404)
            return
        data = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(file.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlparse(self.path).path.startswith("/api"):
            self.handle_api()
        else:
            self.serve_static()

    def do_POST(self):
        self.handle_api()

    def do_PATCH(self):
        self.handle_api()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))


class Server(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    init_db()
    try:
        server = Server((HOST, PORT), Handler)
    except OSError as err:
        raise SystemExit(
            f"Не удалось занять порт {PORT}. Возможно, сайт уже запущен.\n{err}"
        )
    local, lan = site_urls()
    print()
    print("Кабинет заказов запущен.")
    print()
    print(f"  На этом компьютере:  {local}")
    if lan:
        print(f"  В сети Wi-Fi:        {lan}")
    print()
    print("Первый, кто зарегистрируется, становится владельцем.")
    print("Дальше по ссылке регистрируются клиенты.")
    print("Остановка: Ctrl+C")
    print(flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
