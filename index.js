/**
 * @format
 */

// THEME BOOT MUST STAY THE FIRST IMPORT — before App, before anything that
// reaches src/ UI code. Every screen freezes its colors at import time
// (module-level StyleSheet.create), so the palette must be resolved and
// applied before any component module evaluates. './src/theme/boot' reads
// the saved appearance preference + the OS scheme and mutates the shared
// colors object in place; only then may component modules load. Never add
// an import above this line that (transitively) imports a screen or
// component — it would freeze the default palette before boot runs.
import './src/theme/boot';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
