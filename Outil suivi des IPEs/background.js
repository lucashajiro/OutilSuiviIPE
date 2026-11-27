// Clic sur l'icône de l'extension :
//  - sur une page du dashboard Smart Impulse : on lit les données du graphique affiché,
//    puis on ouvre l'application qui les charge automatiquement ;
//  - ailleurs : on ouvre simplement l'application.
importScripts('js/extract.js');

const DASHBOARD = /^https:\/\/dashboard\.smart-impulse\.com\//;

chrome.action.onClicked.addListener(async tab => {
  if (tab && tab.url && DASHBOARD.test(tab.url)) {
    let pending;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN', // nécessaire pour accéder au graphique de la page
        func: extractSmartImpulseData,
      });
      pending = res && res.result ? res.result : { error: 'Aucune donnée renvoyée par la page.' };
    } catch (e) {
      pending = { error: 'Lecture impossible : ' + e.message };
    }
    pending.at = Date.now();
    await chrome.storage.local.set({ pendingImport: pending });
  }
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});
