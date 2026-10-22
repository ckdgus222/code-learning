import { contextBridge, ipcRenderer } from 'electron';
import { channels, type LearningApi, type ProjectEvent } from '../shared/contracts';
import type { LearningEvent } from '../shared/ai';

const api: LearningApi = {
  openProject: () => ipcRenderer.invoke(channels.open),
  readSource: input => ipcRenderer.invoke(channels.read, input),
  readEvidence: input => ipcRenderer.invoke(channels.evidence, input),
  cancel: () => ipcRenderer.invoke(channels.cancel),
  routes: input => ipcRenderer.invoke(channels.routes, input),
  cancelRoutes: input => ipcRenderer.invoke(channels.cancelRoutes, input),
  featureFlow: input => ipcRenderer.invoke(channels.featureFlow, input),
  cancelFeatureFlow: input => ipcRenderer.invoke(channels.cancelFeatureFlow, input),
  projectMap: input => ipcRenderer.invoke(channels.map, input),
  cancelProjectMap: input => ipcRenderer.invoke(channels.cancelMap, input),
  functionCalls: input => ipcRenderer.invoke(channels.calls, input),
  cancelFunctionCalls: input => ipcRenderer.invoke(channels.cancelCalls, input),
  valueShapes: input => ipcRenderer.invoke(channels.shapes, input),
  cancelValueShapes: input => ipcRenderer.invoke(channels.cancelShapes, input),
  gitHistory: input => ipcRenderer.invoke(channels.history, input),
  projectChanges: input => ipcRenderer.invoke(channels.changes, input),
  fileDiff: input => ipcRenderer.invoke(channels.diff, input),
  cancelChanges: input => ipcRenderer.invoke(channels.cancelChanges, input),
  checkConnections: () => ipcRenderer.invoke(channels.connections),
  startExplanation: input => ipcRenderer.invoke(channels.explain, input),
  startOverview: input => ipcRenderer.invoke(channels.overview, input),
  startFeatureGuide: input => ipcRenderer.invoke(channels.featureGuide, input),
  startFileExplanation: input => ipcRenderer.invoke(channels.fileExplanation, input),
  cancelExplanation: input => ipcRenderer.invoke(channels.cancelExplanation, input),
  onLearningEvent: listener => {
    const receive = (_event: Electron.IpcRendererEvent, value: LearningEvent) => listener(value);
    ipcRenderer.on(channels.learningEvent, receive);
    return () => ipcRenderer.removeListener(channels.learningEvent, receive);
  },
  onProjectEvent: listener => {
    const receive = (_event: Electron.IpcRendererEvent, value: ProjectEvent) => listener(value);
    ipcRenderer.on(channels.event, receive);
    return () => ipcRenderer.removeListener(channels.event, receive);
  },
};
contextBridge.exposeInMainWorld('learning', api);
