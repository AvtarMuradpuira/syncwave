<?php
// Duration and channel count from WAV / FLAC headers. Browsers report the duration
// of every other format after they decode it (the 'meta' message).

function probe_audio(string $file): array
{
    $fh = @fopen($file, 'rb');
    if (!$fh) return [];
    $b = fread($fh, 65536) ?: '';
    fclose($fh);
    $size = @filesize($file) ?: 0;
    return parse_wav($b, $size) ?? parse_flac($b) ?? [];
}

function parse_wav(string $b, int $size): ?array
{
    if (substr($b, 0, 4) !== 'RIFF' || substr($b, 8, 4) !== 'WAVE') return null;
    $off = 12;
    $channels = null;
    $byteRate = null;
    while ($off + 8 <= strlen($b)) {
        $id = substr($b, $off, 4);
        $len = unpack('V', substr($b, $off + 4, 4))[1];
        if ($id === 'fmt ' && $off + 20 <= strlen($b)) {
            $channels = unpack('v', substr($b, $off + 10, 2))[1];
            $byteRate = unpack('V', substr($b, $off + 16, 4))[1];
        }
        if ($id === 'data') {
            $dataLen = ($len === 0xffffffff || $len === 0) ? $size - $off - 8 : min($len, $size - $off - 8);
            return ['channels' => $channels, 'duration' => $byteRate ? $dataLen / $byteRate : null];
        }
        $off += 8 + $len + ($len & 1);
    }
    return $channels ? ['channels' => $channels, 'duration' => null] : null;
}

function parse_flac(string $b): ?array
{
    if (substr($b, 0, 4) !== 'fLaC' || strlen($b) < 26) return null;
    $si = 8; // STREAMINFO body starts after the 4-byte marker + 4-byte block header
    $by = fn($i) => ord($b[$si + $i]);
    $rate = ($by(10) << 12) | ($by(11) << 4) | ($by(12) >> 4);
    $channels = (($by(12) >> 1) & 0x07) + 1;
    $total = ($by(13) & 0x0f) * 4294967296 + unpack('N', substr($b, $si + 14, 4))[1];
    return ['channels' => $channels, 'duration' => $rate && $total ? $total / $rate : null];
}
