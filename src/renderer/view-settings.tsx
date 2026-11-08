import React, { useEffect, useRef, useState } from 'react';
import type { UpdateCheck, ViewSettings } from '../shared/contracts';
import { Icon } from './icons';

export function ViewSettingsButton() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ViewSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [updateError, setUpdateError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const updatePending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    void window.learning.getViewSettings().then(result => {
      if (!active) return;
      if (!result.ok) { setError(result.message); return; }
      setSettings(result.value);
      document.documentElement.dataset.codeColors = result.value.codeColors;
    }).catch(() => { if (active) setError('보기 설정을 불러오지 못했어요.'); });
    return () => { active = false; mounted.current = false; };
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

  async function checkUpdate() {
    if (updatePending.current) return;
    updatePending.current = true;
    setChecking(true);
    setUpdate(null);
    setUpdateError('');
    try {
      const result = await window.learning.checkForUpdate();
      if (!mounted.current) return;
      if (!result.ok) { setUpdateError(result.message); return; }
      setUpdate(result.value);
    } catch {
      if (mounted.current) setUpdateError('새 버전을 확인하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.');
    } finally {
      updatePending.current = false;
      if (mounted.current) setChecking(false);
    }
  }

  async function openRelease() {
    setUpdateError('');
    try {
      const result = await window.learning.openReleasePage();
      if (!mounted.current) return;
      if (!result.ok) setUpdateError(result.message);
    } catch {
      if (mounted.current) setUpdateError('내려받기 페이지를 열지 못했어요. 다시 눌러 주세요.');
    }
  }

  return <div className="view-settings" ref={container}>
    <button ref={button} className="btn btn--ghost btn--icon" aria-label="앱 설정" title="앱 설정"
      aria-expanded={open} aria-controls="view-settings" onClick={() => setOpen(value => !value)}><Icon name="gear" /></button>
    {open && <div id="view-settings" className="view-settings__popup" role="dialog" aria-label="앱 설정" aria-busy={saving}>
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
      <section role="group" aria-label="버전">
        <h3>버전</h3>
        <button className="btn btn--small" disabled={checking} onClick={() => void checkUpdate()}>
          {checking ? '확인 중…' : '새 버전 확인'}
        </button>
        {update && <p role="status">
          {update.status === 'newer' && `새 버전 ${update.latest}이 있어요. 지금은 ${update.current}예요.`}
          {update.status === 'latest' && `지금 버전 ${update.current}이 최신이에요.`}
          {update.status === 'none' && `아직 공개된 버전이 없어요. 지금은 ${update.current}예요.`}
        </p>}
        {update?.status === 'newer' && <button className="btn btn--small btn--primary" onClick={() => void openRelease()}>내려받기 페이지 열기</button>}
        {updateError && <p role="alert">{updateError}</p>}
      </section>
    </div>}
  </div>;
}
