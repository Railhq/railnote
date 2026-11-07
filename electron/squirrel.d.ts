/** True when the Windows installer started the app for setup; it has done its work by then. */
declare module "electron-squirrel-startup" {
  const started: boolean;
  export default started;
}
