// Toolbar button and the optional keyboard command both just toggle the find bar.
// If the tab has no content script yet (it was open before install), inject it first.
async function toggle(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'toggle' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tabId, { type: 'toggle' });
    } catch {
      // chrome:// pages, the Web Store, PDF viewer, etc. can't be scripted.
    }
  }
}

chrome.action.onClicked.addListener((tab) => tab.id != null && toggle(tab.id));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-find' && tab?.id != null) toggle(tab.id);
});

// Make ⌘F work immediately in tabs that were already open on install / reload.
// Skip tabs whose content script already answers: re-injecting would close an open bar.
// Copies orphaned by a reload can't answer, so they still get replaced.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id == null || tab.discarded) continue;
    chrome.tabs.sendMessage(tab.id, { type: 'ping' })
      .catch(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }))
      .catch(() => {});
  }
});
