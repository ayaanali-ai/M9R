# Inactive Chromium document fixture

Use a disposable Chromium profile. This fixture is independent of the M9R broker and has access only to loopback pages. It does not ship with M9R.

1. From this folder, serve the files with `python -m http.server 8765 --bind 127.0.0.1`.
2. In the disposable profile, load this folder unpacked from `chrome://extensions`.
3. Open `http://127.0.0.1:8765/document.html?role=owner` and `http://127.0.0.1:8765/document.html?role=agent` in the same window. Select the owner tab.
4. Open the fixture extension popup and click **Check inactive document**.

The check appends to the exact agent document, reads both values, verifies the owner tab remains active, then reloads the agent tab and checks that Chrome refuses the old document ID. Reload both tabs to reset the fixture before repeating. The popup check does not measure Windows foreground focus.
