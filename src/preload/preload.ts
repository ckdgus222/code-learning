import { contextBridge, ipcRenderer } from 'electron';
import { channels, type LearningApi, type ProjectEvent } from '../shared/contracts';
import type { LearningEvent } from '../shared/ai';

const codeColorsArgument = process.argv.find(argument => argument.startsWith('--code-colors='));
const codeColors = codeColorsArgument === '--code-colors=contrast' ? 'contrast' : 'default';
if (document.documentElement) {
  document.documentElement.dataset.codeColors = codeColors;
} else {
  // Preload can run before <html> exists. Observe its insertion before the first paint.
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    document.documentElement.dataset.codeColors = codeColors;
    observer.disconnect();
  });
  observer.observe(document, { childList: true });
}

const api: LearningApi = {
  exportMap: input => ipcRenderer.invoke(channels.exportMap, input),
  geminiKeyStatus: () => ipcRenderer.invoke(channels.geminiKeyStatus),
  saveGeminiKey: input => ipcRenderer.invoke(channels.saveGeminiKey, input),
  clearGeminiKey: () => ipcRenderer.invoke(channels.clearGeminiKey),
  checkForUpdate: () => ipcRenderer.invoke(channels.checkForUpdate),
  openReleasePage: () => ipcRenderer.invoke(channels.openReleasePage),
  getViewSettings: () => ipcRenderer.invoke(channels.getViewSettings),
  setViewSettings: input => ipcRenderer.invoke(channels.setViewSettings, input),
  savedPlanCompare: input => ipcRenderer.invoke(channels.savedPlanCompare, input),
  savePlanCompare: input => ipcRenderer.invoke(channels.savePlanCompare, input),
  deletePlanCompare: input => ipcRenderer.invoke(channels.deletePlanCompare, input),
  startPlanCompare: input => ipcRenderer.invoke(channels.planCompare, input),
  checkPlanCompare: input => ipcRenderer.invoke(channels.planCompareCheck, input),
  pickPlanDocument: () => ipcRenderer.invoke(channels.pickPlanDocument),
  openProject: () => ipcRenderer.invoke(channels.open),
  recentProjects: () => ipcRenderer.invoke(channels.recentProjects),
  openRecent: input => ipcRenderer.invoke(channels.openRecent, input),
  learningSpot: input => ipcRenderer.invoke(channels.learningSpot, input),
  learningMarks: input => ipcRenderer.invoke(channels.learningMarks, input),
  saveLearningMark: input => ipcRenderer.invoke(channels.saveLearningMark, input),
  saveLearningSpot: input => ipcRenderer.invoke(channels.saveLearningSpot, input),
  readSource: input => ipcRenderer.invoke(channels.read, input),
  readEvidence: input => ipcRenderer.invoke(channels.evidence, input),
  cancel: () => ipcRenderer.invoke(channels.cancel),
  routes: input => ipcRenderer.invoke(channels.routes, input),
  cancelRoutes: input => ipcRenderer.invoke(channels.cancelRoutes, input),
  featureFlows: input => ipcRenderer.invoke(channels.featureFlows, input),
  cancelFeatureFlows: input => ipcRenderer.invoke(channels.cancelFeatureFlows, input),
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
  checkConnections: request => ipcRenderer.invoke(channels.connections, request),
  startExplanation: input => ipcRenderer.invoke(channels.explain, input),
  startOverview: input => ipcRenderer.invoke(channels.overview, input),
  savedFeatureGuide: input => ipcRenderer.invoke(channels.savedFeatureGuide, input),
  saveFeatureGuide: input => ipcRenderer.invoke(channels.saveFeatureGuide, input),
  deleteFeatureGuide: input => ipcRenderer.invoke(channels.deleteFeatureGuide, input),
  startFeatureGuide: input => ipcRenderer.invoke(channels.featureGuide, input),
  savedAnswers: input => ipcRenderer.invoke(channels.savedAnswers, input),
  savedAnswer: input => ipcRenderer.invoke(channels.savedAnswer, input),
  openSavedEvidence: input => ipcRenderer.invoke(channels.openSavedEvidence, input),
  saveAnswer: input => ipcRenderer.invoke(channels.saveAnswer, input),
  deleteAnswer: input => ipcRenderer.invoke(channels.deleteAnswer, input),
  savedOverview: input => ipcRenderer.invoke(channels.savedOverview, input),
  saveOverview: input => ipcRenderer.invoke(channels.saveOverview, input),
  deleteOverview: input => ipcRenderer.invoke(channels.deleteOverview, input),
  savedFileExplanation: input => ipcRenderer.invoke(channels.savedFileExplanation, input),
  saveFileExplanation: input => ipcRenderer.invoke(channels.saveFileExplanation, input),
  deleteFileExplanation: input => ipcRenderer.invoke(channels.deleteFileExplanation, input),
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
