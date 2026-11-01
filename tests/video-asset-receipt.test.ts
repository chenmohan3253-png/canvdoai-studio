import {describe, expect, it} from 'vitest';
import {videoAssetReceipt} from '../runtime/video-asset-receipt';

describe('video asset upload receipts shared by canvas and one-click production', () => {
  it('accepts a private object key without inventing a public URL', () => {
    const receipt = {object_key:'bridge-assets/test', sha256:'a'.repeat(64), kind:'image', bytes:123};
    expect(videoAssetReceipt(receipt,'image','first_frame',0)).toEqual({...receipt,role:'first_frame',order:0});
    expect(receipt).not.toHaveProperty('role');
    expect(videoAssetReceipt({...receipt,url:'file:///unexpected'},'image','first_frame',0)).not.toHaveProperty('url');
  });
  it('preserves public upload compatibility and replaces provider-supplied role/order', () => {
    expect(videoAssetReceipt({cdn_url:'https://example.com/image.png',role:'reference',order:99},'image','last_frame',1))
      .toEqual({cdn_url:'https://example.com/image.png',url:'https://example.com/image.png',kind:'image',role:'last_frame',order:1});
  });
  it.each(['image','video','audio'])('retains a %s reference type', kind => {
    expect(videoAssetReceipt({object_key:'asset',kind},kind,'reference',2)).toMatchObject({kind,role:'reference',order:2});
  });
  it.each([null,[],{}, {object_key:{}}, {object_key:'  '}, {cdn_url:'file:///secret'}, {cdn_url:'https://user:pass@example.com/a'}, {object_key:'asset',kind:'audio'}, {object_key:'asset',sha256:'bad'}])('rejects an unusable or mismatched receipt: %j', receipt => {
    expect(()=>videoAssetReceipt(receipt,'image','first_frame',0)).toThrow();
  });
  it('rejects non-image frame inputs and invalid ordering', () => {
    expect(()=>videoAssetReceipt({object_key:'asset'},'audio','last_frame',0)).toThrow();
    expect(()=>videoAssetReceipt({object_key:'asset'},'image','reference',-1)).toThrow();
  });
});
