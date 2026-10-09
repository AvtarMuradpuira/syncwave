<?php
// Cache-busting: run `php stamp.php` before uploading changes. It gives every CSS/JS link and
// JS import a new ?v= number, so browsers and Hostinger's CDN can't keep serving old copies.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$v = date('YmdHis');
$files = array_merge(['index.html', 'room.html'], glob(__DIR__ . '/js/*.js'));
foreach ($files as $f) {
    $path = str_starts_with($f, __DIR__) ? $f : __DIR__ . '/' . $f;
    $s = file_get_contents($path);
    $n = preg_replace(
        '~((?:href|src)="(?:style\.css|js/[\w-]+\.js|manifest\.webmanifest)|from \'\./[\w-]+\.js|\(\'\./[\w-]+\.js)(?:\?v=\w+)?~',
        '$1?v=' . $v,
        $s
    );
    if ($n !== $s) { file_put_contents($path, $n); echo basename($path), "\n"; }
}
echo "version $v\n";
