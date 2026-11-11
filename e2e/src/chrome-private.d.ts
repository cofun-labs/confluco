// chrome.developerPrivate: the private API behind chrome://extensions, available only on that page.
// Just the parts this tool uses.
declare namespace chrome.developerPrivate {
  interface ProfileInfo {
    inDeveloperMode: boolean
  }
  interface ExtensionInfo {
    id: string
    /** ENABLED, DISABLED, TERMINATED, or BLOCKLISTED. */
    state: string
    /** UNPACKED for a folder loaded with "Load unpacked". */
    location: string
    path?: string
    /** Why it is disabled, e.g. unsupportedDeveloperExtension when Developer mode is off. */
    disableReasons: Record<string, boolean>
  }
  interface LoadError {
    error: string
    path: string
  }
  function getProfileConfiguration(callback: (info: ProfileInfo) => void): void
  function getExtensionInfo(id: string, callback: (info?: ExtensionInfo) => void): void
  function reload(id: string, options: { failQuietly?: boolean }, callback: (error?: LoadError) => void): void
}
