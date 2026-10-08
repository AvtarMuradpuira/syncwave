<?php
// SyncWave settings. An environment variable with the same name overrides each value.
return [
    // Largest upload / download per file, in MB. PHP's own limits (post_max_size,
    // upload_max_filesize in php.ini or .user.ini) must be at least this big too.
    'MAX_UPLOAD_MB' => 500,

    // Optional search sources. Audius and Archive.org work without any key.
    'JAMENDO_CLIENT_ID' => '',   // free at https://devportal.jamendo.com
    'YOUTUBE_API_KEY' => '',     // pasting YouTube links works without it

    // Allow links to LAN addresses (e.g. a NAS). Off by default to prevent
    // server-side request forgery.
    'ALLOW_PRIVATE_URLS' => false,

    // Where the database and the audio files live. Both folders must be writable by PHP.
    // media/ must stay inside the web root (browsers load audio from it);
    // data/ is protected by its own .htaccess, or move it outside the web root.
    'DATA_DIR' => __DIR__ . '/data',
    'MEDIA_DIR' => __DIR__ . '/media',
];
