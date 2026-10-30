import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CodeStep, CodeSymbol, Evidence, LearningMark, LearningSpot, MarkKey, ProjectView, RecentProject, SavedSpot, SourceView } from '../shared/contracts';
import { nextMark, sameMarkKey, type MarkChange } from './marks';
import { recordPlace, spotOf, type Place, type Topic } from './overview';
import type { View } from './selection';

const SAVE_FAILED = '학습 위치를 저장하지 못했어요. 다음에 이어서 보기가 예전 위치일 수 있어요.';

// Keeps learning progress and its saved state together while the app controls navigation.
export function useLearning({ project, openedAt, view, busy, stale, source, symbol, step, stepId, evidence, setNotice }: {
  project: ProjectView | null; openedAt: RefObject<number>; view: View; busy: boolean; stale: boolean;
  source: SourceView | null; symbol: CodeSymbol | undefined; step: CodeStep | undefined; stepId: string | null;
  evidence: Evidence | null; setNotice(message: string): void;
}) {
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [resume, setResume] = useState<{ projectId: string; saved: SavedSpot } | null>(null);
  const [marks, setMarks] = useState<{ projectId: string; list: LearningMark[] } | null>(null);
  const [pendingMarks, setPendingMarks] = useState<MarkKey[]>([]);
  const savingMarks = useRef<MarkKey[]>([]);
  // Plan F1: the topic being learned.
  const [topic, setTopic] = useState<Topic | null>(null);
  // The places looked at under the topic (the last 20).
  const [places, setPlaces] = useState<Place[]>([]);

  // Plan F1: while a topic is open, each settled place in the code views is recorded.
  // A change notice clears the marks, which is no move: nothing is recorded while the code waits for a re-read.
  useEffect(() => {
    if (!topic || busy || stale || !source || (view !== 'function' && view !== 'code')) return;
    const range = evidence && evidence.fileId === source.fileId
      ? { startUtf16: evidence.startUtf16, endUtf16: evidence.endUtf16, startLine: evidence.startLine, endLine: evidence.endLine } : null;
    const place: Place = { view, fileId: source.fileId, fileHash: source.hash, range,
      symbol: symbol ? { name: symbol.name, startUtf16: symbol.evidence.startUtf16, step: step ? symbol.steps.indexOf(step) : null } : null };
    setPlaces(previous => recordPlace(previous, place));
  }, [topic === null, busy, stale, view, source?.fileId, source?.hash, symbol?.id, stepId, evidence?.id]);

  useEffect(() => {
    if (project) return;
    let cancelled = false;
    void window.learning.recentProjects().then(result => {
      if (!cancelled && result.ok) setRecentProjects(result.value);
    });
    return () => { cancelled = true; };
  }, [project]);

  const lastPlace = places.at(-1) ?? null;
  useEffect(() => {
    // Opening or closing a folder clears the topic in memory, never its saved location.
    if (!project || !topic) return;
    try { void saveSpot(project.id, spotOf(topic, lastPlace, project.files)); }
    catch { setNotice(SAVE_FAILED); }
  }, [project, topic, lastPlace]);

  async function saveSpot(projectId: string, spot: LearningSpot | null) {
    try {
      const result = await window.learning.saveLearningSpot({ projectId, spot });
      if (result.ok || result.code === 'PROJECT_CLOSED') return;
    } catch { /* An unavailable IPC connection is also a save failure. */ }
    setNotice(SAVE_FAILED);
  }

  async function load(id: string, opening: number) {
    await Promise.all([
      window.learning.learningSpot({ projectId: id }).then(saved => {
        if (opening !== openedAt.current) return;
        if (saved.ok && saved.value) setResume({ projectId: id, saved: saved.value });
      }),
      window.learning.learningMarks({ projectId: id }).then(saved => {
        if (opening !== openedAt.current) return;
        if (saved.ok) setMarks({ projectId: id, list: saved.value });
        else if (saved.code !== 'PROJECT_CLOSED') setNotice('학습 기록을 불러오지 못했어요.');
      }),
    ]);
  }

  async function saveMark(key: MarkKey, change: MarkChange, currentHash: string) {
    if (!project || marks?.projectId !== project.id || busy || stale || savingMarks.current.some(item => sameMarkKey(item, key))) return;
    const opening = openedAt.current;
    const mark = nextMark(marks.list.find(item => sameMarkKey(item, key)), change, currentHash, key);
    savingMarks.current = [...savingMarks.current, key];
    setPendingMarks(savingMarks.current);
    try {
      const result = await window.learning.saveLearningMark({ projectId: project.id, mark });
      if (opening !== openedAt.current) return;
      if (!result.ok) {
        if (result.code !== 'PROJECT_CLOSED') setNotice('학습 기록을 저장하지 못했어요.');
        return;
      }
      setMarks(previous => {
        if (previous?.projectId !== project.id) return previous;
        const list = previous.list.filter(item => !sameMarkKey(item, key));
        if (result.value) list.push(result.value);
        return { projectId: project.id, list };
      });
    } catch {
      if (opening === openedAt.current) setNotice('학습 기록을 저장하지 못했어요.');
    } finally {
      if (opening === openedAt.current) {
        savingMarks.current = savingMarks.current.filter(item => !sameMarkKey(item, key));
        setPendingMarks(savingMarks.current);
      }
    }
  }

  /** A new topic (or none) starts with no places looked at. */
  function beginTopic(next: Topic | null) { setTopic(next); setPlaces([]); }

  function closeTopic() {
    beginTopic(null); setResume(null);
    if (project) void saveSpot(project.id, null);
  }

  function forget() {
    setMarks(null); savingMarks.current = []; setPendingMarks([]);
    setResume(null);
    beginTopic(null);
  }

  return { recentProjects, resume, setResume, marks, pendingMarks, saveMark, topic, setTopic, places, setPlaces,
    beginTopic, closeTopic, load, forget };
}
