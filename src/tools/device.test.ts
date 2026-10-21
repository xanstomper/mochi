import { describe, it, expect } from 'vitest';
import { parseAdbDevices, resolveKeyCode, escapeInputText, parseUiDump } from './device.js';

describe('device helpers', () => {
  it('parses adb devices -l output', () => {
    const out = parseAdbDevices(`List of devices attached
R58M12345    device usb:1-1 product:beyond1lte model:SM_G973F device:beyond1 transport_id:3
emulator-5554  offline
`);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ serial: 'R58M12345', state: 'device', model: 'SM G973F' });
    expect(out[1].state).toBe('offline');
  });

  it('resolves friendly key names and raw codes', () => {
    expect(resolveKeyCode('home')).toBe(3);
    expect(resolveKeyCode('BACK')).toBe(4);
    expect(resolveKeyCode('volume up')).toBe(24);
    expect(resolveKeyCode('66')).toBe(66);
    expect(resolveKeyCode('definitely-not-a-key')).toBeNull();
  });

  it('encodes spaces for adb input text without doubling percent signs', () => {
    expect(escapeInputText('hello world')).toBe('hello%sworld');
    expect(escapeInputText('100% done')).toBe('100%%sdone');
  });

  it('extracts actionable nodes from a uiautomator dump', () => {
    const xml = `<hierarchy><node text="Sign in" clickable="true" class="android.widget.Button" bounds="[10,20][100,60]" resource-id="btn"/>
      <node text="" clickable="false" class="android.widget.TextView"/>
      <node content-desc="Search" clickable="true" class="android.widget.EditText" bounds="[0,0][10,10]"/></hierarchy>`;
    const nodes = parseUiDump(xml);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ text: 'Sign in', clickable: true, class: 'Button' });
    expect(nodes[1]).toMatchObject({ text: 'Search', resourceId: undefined });
  });
});
