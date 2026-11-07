import React, { useEffect, useRef, useState } from 'react';
import type { ViewSettings } from '../shared/contracts';
import { Icon } from './icons';

export function ViewSettingsButton() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ViewSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);

  useEffect(() => {
    let active = true;
    void window.learning.getViewSettings().then(result => {
      if (!active) return;
      if (!result.ok) { setError(result.message); return; }
      setSettings(result.value);
      document.documentElement.dataset.codeColors = result.value.codeColors;
    }).catch(() => { if (active) setError('보기 설정을 불러오지 못했어요.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  async function change(next: ViewSettings) {
    if (!settings || pending.current) return;
    const saved = settings;
    pending.current = true;
    setSaving(true);
    setError('');
    setSettings(next);
    try {
      const result = await window.learning.setViewSettings(next);
      if (!result.ok) {
        setSettings(saved);
        setError(result.message);
        return;
      }
      setSettings(result.value);
      document.documentElement.dataset.codeColors = result.value.codeColors;
    } catch {
      setSettings(saved);
      setError('보기 설정을 저장하지 못했어요. 다시 골라 주세요.');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return <div className="view-settings" ref={container}>
    <button ref={button} className="btn btn--ghost btn--icon" aria-label="보기 설정" title="보기 설정"
      aria-expanded={open} aria-controls="view-settings" onClick={() => setOpen(value => !value)}><Icon name="gear" /></button>
    {open && <div id="view-settings" className="view-settings__popup" role="dialog" aria-label="보기 설정" aria-busy={saving}>
      <fieldset disabled={!settings} aria-disabled={saving}>
        <legend>화면</legend>
        {([['system', '시스템 따라가기'], ['light', '밝게'], ['dark', '어둡게']] as const).map(([value, label]) =>
          <label key={value}><input type="radio" name="screen" value={value} checked={settings?.screen === value}
            onChange={() => { if (settings) void change({ ...settings, screen: value }); }} />{label}</label>)}
      </fieldset>
      <fieldset disabled={!settings} aria-disabled={saving}>
        <legend>코드 색</legend>
        {([['default', '기본'], ['contrast', '고대비']] as const).map(([value, label]) =>
          <label key={value}><input type="radio" name="codeColors" value={value} checked={settings?.codeColors === value}
            onChange={() => { if (settings) void change({ ...settings, codeColors: value }); }} />{label}</label>)}
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}
