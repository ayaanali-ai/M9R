# Store screenshots — capture manually, then stage

Do not use fabricated interface mockups as store screenshots. Capture the real, release-build extension in Chrome after local integration and permission behavior have been tested. Suggested sequence:

1. M9R extension popup with the owner deciding whether to allow the active site.
2. Chrome's site permission prompt and M9R's explanation of the site-wide origin scope.
3. A permitted test page showing two distinct M9R agent presence markers.
4. A visible-page read result in the M9R workflow (use synthetic, non-sensitive demo content).
5. A blocked password/one-time-code field result, if it can be shown without exposing real data.

Use synthetic data and a controlled demo site only. Avoid account names, real URLs, private messages, tokens, real customer records, or browser chrome that reveals personal information. Save one to five PNG captures at exactly 1280x800 in a separate source folder, then run `node scripts/stage-browser-store-screenshots.mjs <source-folder> <destination-folder>`. The helper validates PNG structure and dimensions and copies without overwriting. It does not launch a browser, take screenshots, or certify any other dashboard requirements.
