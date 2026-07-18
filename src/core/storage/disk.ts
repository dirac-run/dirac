// Barrel re-export file for disk storage utilities.
// Existing imports from "@core/storage/disk" or "@/core/storage/disk" continue to work.
// Uses `export const` pattern (not `export { X } from`) so sinon can stub individual functions.
// TypeScript's `export { X }` creates getter-defined live bindings that sinon cannot replace.

import * as _atomicWrite from "./atomicWrite"
import * as _conversationHistory from "./conversationHistory"
import * as _conversationHistoryFiles from "./conversationHistoryFiles"
import * as _directoryEnsurers from "./directoryEnsurers"
import * as _environmentMetadata from "./environmentMetadata"
import * as _fileNames from "./fileNames"
import * as _globalStorageDir from "./globalStorageDir"
import * as _hooksStorage from "./hooksStorage"
import * as _paths from "./paths"
import * as _remoteConfigCache from "./remoteConfigCache"
import type { SkillsScanDirectory } from "./skillsStorage"
import * as _skillsStorage from "./skillsStorage"
import * as _taskHistory from "./taskHistory"
import * as _taskStorage from "./taskStorage"

export type { SkillsScanDirectory }
export const atomicWriteFile = _atomicWrite.atomicWriteFile
export const getSavedApiConversationHistory = _conversationHistory.getSavedApiConversationHistory
export const getSavedDiracMessages = _conversationHistory.getSavedDiracMessages
export const saveApiConversationHistory = _conversationHistory.saveApiConversationHistory
export const saveDiracMessages = _conversationHistory.saveDiracMessages
export const cleanupConversationHistoryFile = _conversationHistoryFiles.cleanupConversationHistoryFile
export const writeConversationHistoryJson = _conversationHistoryFiles.writeConversationHistoryJson
export const writeConversationHistoryText = _conversationHistoryFiles.writeConversationHistoryText
export const ensureCacheDirectoryExists = _directoryEnsurers.ensureCacheDirectoryExists
export const ensureHooksDirectoryExists = _directoryEnsurers.ensureHooksDirectoryExists
export const ensureRulesDirectoryExists = _directoryEnsurers.ensureRulesDirectoryExists
export const ensureSettingsDirectoryExists = _directoryEnsurers.ensureSettingsDirectoryExists
export const ensureStateDirectoryExists = _directoryEnsurers.ensureStateDirectoryExists
export const ensureTaskDirectoryExists = _directoryEnsurers.ensureTaskDirectoryExists
export const ensureWorkflowsDirectoryExists = _directoryEnsurers.ensureWorkflowsDirectoryExists
export const collectEnvironmentMetadata = _environmentMetadata.collectEnvironmentMetadata
export const GlobalFileNames = _fileNames.GlobalFileNames
export const getGlobalStorageDir = _globalStorageDir.getGlobalStorageDir
export const getAllHooksDirs = _hooksStorage.getAllHooksDirs
export const getGlobalHooksDir = _hooksStorage.getGlobalHooksDir
export const getWorkspaceHooksDirs = _hooksStorage.getWorkspaceHooksDirs
export const setRuntimeHooksDir = _hooksStorage.setRuntimeHooksDir
export const getDiracHomePath = _paths.getDiracHomePath
export const getDocumentsPath = _paths.getDocumentsPath
export const deleteRemoteConfigFromCache = _remoteConfigCache.deleteRemoteConfigFromCache
export const readRemoteConfigFromCache = _remoteConfigCache.readRemoteConfigFromCache
export const writeRemoteConfigToCache = _remoteConfigCache.writeRemoteConfigToCache
export const ensureAgentSkillsDirectoryExists = _skillsStorage.ensureAgentSkillsDirectoryExists
export const getSkillsDirectoriesForScan = _skillsStorage.getSkillsDirectoriesForScan
export const getTaskHistoryStateFilePath = _taskHistory.getTaskHistoryStateFilePath
export const readTaskHistoryFromState = _taskHistory.readTaskHistoryFromState
export const taskHistoryStateFileExists = _taskHistory.taskHistoryStateFileExists
export const writeTaskHistoryToState = _taskHistory.writeTaskHistoryToState
export const getTaskMetadata = _taskStorage.getTaskMetadata
export const readTaskSettingsFromStorage = _taskStorage.readTaskSettingsFromStorage
export const saveTaskMetadata = _taskStorage.saveTaskMetadata
export const updateTaskMetadata = _taskStorage.updateTaskMetadata
export const writeTaskSettingsToStorage = _taskStorage.writeTaskSettingsToStorage
