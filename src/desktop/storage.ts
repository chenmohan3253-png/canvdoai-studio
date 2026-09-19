import type {} from './bridge';

export const durableStorage = {
  getItem:(key:string):string|null => window.desktop ? window.desktop.storage.getItem(key) : window.localStorage.getItem(key),
  setItem:(key:string,value:string) => window.desktop ? window.desktop.storage.setItem(key,value) : window.localStorage.setItem(key,value),
  removeItem:(key:string) => window.desktop ? window.desktop.storage.removeItem(key) : window.localStorage.removeItem(key),
  keys:():string[] => window.desktop ? window.desktop.storage.keys() : Object.keys(window.localStorage)
};
