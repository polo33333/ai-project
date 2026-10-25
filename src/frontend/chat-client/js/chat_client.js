// Chat client (/chat) runs with its own login, separate from the admin app. The shared chat
// scripts call the API with absolute paths such as /api/...; this sends those requests through
// /chat/... instead, where the server signs them in with the chat session. Loaded before them.
(function routeThroughChatClient() {
  'use strict';
  const PREFIX = '/chat';

  // Returns the /chat/... URL for a same-origin path outside the chat client, otherwise null.
  function chatUrl(value) {
    let url;
    try { url = new URL(String(value), document.baseURI); } catch (_) { return null; }
    if (url.origin !== window.location.origin || url.pathname === PREFIX || url.pathname.startsWith(PREFIX + '/')) return null;
    return PREFIX + url.pathname + url.search + url.hash;
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function chatClientFetch(input, init) {
    if (input instanceof Request) {
      const routed = chatUrl(input.url);
      return nativeFetch(routed ? new Request(routed, input) : input, init);
    }
    const routed = typeof input === 'string' || input instanceof URL ? chatUrl(input) : null;
    return nativeFetch(routed || input, init);
  };

  // Links inside answers, such as exported files under /api/exports/, need the chat session too.
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    const routed = link && chatUrl(link.getAttribute('href'));
    if (routed) link.setAttribute('href', routed);
  }, true);

  window.KhChatClient = { chatUrl };
})();
