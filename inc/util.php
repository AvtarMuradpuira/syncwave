<?php
// Small helpers shared by the API: settings, time, errors, JSON, request context.

function cfg(string $key)
{
    static $c = null;
    if ($c === null) $c = require __DIR__ . '/../config.php';
    $env = getenv($key);
    if ($env !== false && $env !== '') return $env;
    return $c[$key] ?? null;
}

// Epoch milliseconds with sub-millisecond precision (the shared clock all devices sync to).
function now_ms(): float
{
    return microtime(true) * 1000;
}

class HttpError extends Exception
{
    public int $status;
    public function __construct(int $status, string $msg)
    {
        parent::__construct($msg);
        $this->status = $status;
    }
}

function fail(int $status, string $msg)
{
    throw new HttpError($status, $msg);
}

function clamp($v, $lo, $hi)
{
    return min($hi, max($lo, $v));
}

// '' / non-finite -> null, so SQL gets NULL instead of junk
function N($v)
{
    if ($v === null || $v === '') return null;
    if (is_float($v) && !is_finite($v)) return null;
    return $v;
}

function send_json($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
}

// Send the response now and keep working afterwards (downloads), where the server allows it.
function send_json_and_continue($data): void
{
    $body = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    ignore_user_abort(true);
    @set_time_limit(0);
    http_response_code(200);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    if (function_exists('fastcgi_finish_request')) {
        echo $body;
        fastcgi_finish_request();
        return;
    }
    header('Connection: close');
    header('Content-Length: ' . strlen($body));
    echo $body;
    while (ob_get_level() > 0) @ob_end_flush();
    flush();
}

function body(): array
{
    static $b = null;
    if ($b !== null) return $b;
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return $b = [];
    if (strlen($raw) > 1 << 20) fail(413, 'Request too large');
    $j = json_decode($raw, true);
    if (!is_array($j)) fail(400, 'Invalid JSON');
    return $b = $j;
}

function hdr(string $name): ?string
{
    $k = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    return isset($_SERVER[$k]) && $_SERVER[$k] !== '' ? (string)$_SERVER[$k] : null;
}

function device_id(): ?string
{
    $d = hdr('x-device-id');
    return $d === null ? null : substr($d, 0, 64);
}

function by_name(): ?string
{
    $n = hdr('x-name');
    if ($n === null) return null;
    $n = mb_substr(trim(rawurldecode($n)), 0, 40);
    return $n === '' ? null : $n;
}

function uuid(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    $h = bin2hex($b);
    return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-' . substr($h, 12, 4) . '-' . substr($h, 16, 4) . '-' . substr($h, 20);
}

// php.ini sizes like "40M" -> bytes
function ini_bytes(string $v): int
{
    $v = trim($v);
    if ($v === '' || $v === '-1' || $v === '0') return PHP_INT_MAX;
    $n = (float)$v;
    switch (strtolower(substr($v, -1))) {
        case 'g': $n *= 1024;
        case 'm': $n *= 1024;
        case 'k': $n *= 1024;
    }
    return (int)$n;
}

// Largest upload this server will really accept: our setting, capped by PHP's request limit.
function max_upload_bytes(): int
{
    $ours = (int)cfg('MAX_UPLOAD_MB') * 1048576;
    return (int)min($ours, ini_bytes((string)ini_get('post_max_size')));
}
