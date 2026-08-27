/**
 * react-native-qrcode-svg is ES modules on top of react-native-svg, and
 * react-native-svg's commonjs build reaches for @react-native/assets-registry,
 * which this tree does not install. Transforming it therefore trades an
 * "Unexpected token 'export'" for a "Cannot find module" — so the QR view is
 * MOCKED rather than transformed.
 *
 * Nothing is lost. No suite asserts pixels of a QR; what the suites assert is
 * the LINK the component is handed (podLink.test.ts) and the fact that the
 * mount exists (crew.test.tsx). Both survive a stub, and the stub is what
 * keeps every suite that touches the pod card from dying at import time —
 * which is exactly what happened the moment PodQr mounted inside CrewSection,
 * because until then no test had ever reached this import.
 */
const React = require('react');
module.exports = function QRCode(props) {
  // Carries `value` through so a test CAN assert the encoded link if it ever
  // wants to; renders nothing.
  return React.createElement('QRCode', { value: props && props.value });
};
module.exports.default = module.exports;
