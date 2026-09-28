# Safari-style Find for Chrome

Replaces Chrome's ⌘F with Safari's find experience: the page dims, every match is
spotlighted in a white pill, and the current match is yellow with a little bounce.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this folder
4. Already-open tabs get the script automatically; no need to reload them

After editing the code, hit the reload icon on the extension card.

## Keys

| Key | Action |
| --- | --- |
| ⌘F | Open the bar (or re-focus it) |
| ↩ / ⇧↩ | Next / previous match |
| ⌘G / ⇧⌘G | Next / previous match, even with focus on the page |
| ⌘E | Find the selected text |
| Esc / Done | Close; the current match stays selected |

Clicking the page drops the spotlight but keeps the bar, like Safari. The
**Contains / Begins with** choice is remembered.

Matching ignores case and accents (`sao paulo` finds "São Paulo"), crosses inline
tags (`Ye<b>lp</b>`), and searches open shadow DOM. Hidden and screen-reader-only
text is skipped, and matches covered by popups or modals aren't painted.

## Limits

- Chrome won't let extensions run on `chrome://` pages, the Web Store, or the
  built-in PDF viewer. ⌘F falls through to Chrome's own find there.
- Only the top frame is searched (not iframes).
- Text drawn on a canvas (Google Docs, Figma) can't be found by any extension.
- Contents of `<input>` / `<textarea>` aren't searched.
- The bar floats over the page's top-right corner, since an extension can't add
  a strip to Chrome's own toolbar.
