import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ProjectView } from '../shared/contracts';
import type { MapEntry } from './project-map';
import type { View } from './selection';

// Keeps the file map and its pending build together so other views can share the same map.
export function useMap({ project, revision, view, tab, setError }: {
  project: ProjectView | null; revision: RefObject<number>; view: View; tab: 'feature' | 'file';
  setError(message: string): void;
}) {
  // The map is drawn by its own worker, so it has its own request counter: reads may go on meanwhile.
  const [projectMap, setProjectMap] = useState<MapEntry | null>(null);
  const [mapping, setMapping] = useState(false);
  const mapRequest = useRef(0);

  // The map is drawn the first time it is looked at after a folder opens.
  useEffect(() => {
    if (view === 'map' && tab === 'file' && project && !projectMap && !mapping) void buildMap();
  }, [view, project, tab]);

  function forgetMap() { mapRequest.current++; setProjectMap(null); setMapping(false); }
  async function buildMap() {
    if (!project) return;
    const current = ++mapRequest.current;
    const atRevision = revision.current;
    setMapping(true); setError('');
    const result = await window.learning.projectMap({ projectId: project.id });
    if (current !== mapRequest.current) return;
    setMapping(false);
    if (!result.ok) { if (result.code !== 'CANCELLED') setError(result.message); return; }
    // A change notice that arrived while the map was drawn keeps it marked for a re-check.
    setProjectMap({ map: result.value, revision: atRevision, build: current });
  }
  async function cancelMap() {
    if (!project) return;
    mapRequest.current++;
    setMapping(false);
    const result = await window.learning.cancelProjectMap({ projectId: project.id });
    if (!result.ok) setError(result.message);
  }

  return { entry: projectMap, mapping, forget: forgetMap, build: buildMap, cancel: cancelMap };
}
