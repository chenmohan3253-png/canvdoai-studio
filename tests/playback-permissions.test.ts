import {describe,it,expect,vi} from 'vitest';
import {allowsDesktopFullscreen,installPlaybackPermissions} from '../electron/playback-permissions';

const valid={permission:'fullscreen',requestingUrl:'http://127.0.0.1:32100/canvas/test',mainUrl:'http://127.0.0.1:32100/canvas/test',localOrigin:'http://127.0.0.1:32100',isMainFrame:true,isMainWindow:true};
describe('desktop video fullscreen permissions',()=>{
  it('allows fullscreen only for our top-level player',()=>expect(allowsDesktopFullscreen(valid)).toBe(true));
  it.each(['media','display-capture','notifications','clipboard-read','geolocation','openExternal'])('still denies %s',permission=>expect(allowsDesktopFullscreen({...valid,permission})).toBe(false));
  it.each([
    {isMainFrame:false},{isMainWindow:false},{requestingUrl:'https://example.invalid'},
    {requestingUrl:'http://127.0.0.1:32101/canvas'},{requestingUrl:'http://127.0.0.1:32100.evil.invalid'},
    {requestingUrl:'data:text/html,test'},{requestingUrl:''},{mainUrl:'https://example.invalid'},
  ])('rejects foreign/invalid contexts: %j',override=>expect(allowsDesktopFullscreen({...valid,...override})).toBe(false));
  it('installs both handlers, checking the actual WebContents identity',()=>{
    const session={setPermissionCheckHandler:vi.fn(),setPermissionRequestHandler:vi.fn()};
    const web={getURL:()=>valid.mainUrl,isDestroyed:()=>false};
    installPlaybackPermissions(session as any,valid.localOrigin,()=>web as any);
    const check=session.setPermissionCheckHandler.mock.calls[0][0];
    const request=session.setPermissionRequestHandler.mock.calls[0][0];
    const details={isMainFrame:true,requestingUrl:valid.requestingUrl};
    expect(check(web,'fullscreen',valid.localOrigin,details)).toBe(true);
    expect(check({...web},'fullscreen',valid.localOrigin,details)).toBe(false);
    expect(check(null,'fullscreen',valid.localOrigin,details)).toBe(false);
    const callback=vi.fn();request(web,'fullscreen',callback,details);expect(callback).toHaveBeenLastCalledWith(true);
    request(web,'media',callback,details);expect(callback).toHaveBeenLastCalledWith(false);
  });
});
