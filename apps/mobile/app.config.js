const fs = require('fs');
const path = require('path');

// One app per environment, so a tester can have the staging and production apps
// installed side by side and always know which one they are in.
const VARIANTS = {
  development: { nameSuffix: ' (Dev)', idSuffix: '.dev' },
  staging: { nameSuffix: ' (Staging)', idSuffix: '.staging' },
  production: { nameSuffix: '', idSuffix: '' },
};

module.exports = ({ config }) => {
  const variant = VARIANTS[process.env.APP_ENV] ?? VARIANTS.production;
  config.name = config.name + variant.nameSuffix;
  config.android = { ...config.android, package: config.android.package + variant.idSuffix };

  // Plain http is only for a development build talking to a machine on the same
  // Wi-Fi. Staging and production servers are https, so those builds refuse it.
  config.plugins = (config.plugins ?? []).map((p) =>
    Array.isArray(p) && p[0] === 'expo-build-properties'
      ? ['expo-build-properties', { android: { usesCleartextTraffic: process.env.APP_ENV === 'development' || !process.env.APP_ENV } }]
      : p,
  );

  // Firebase file for push alerts (see SETUP.md). Without it the app still builds; alerts stay off.
  const googleServices = path.join(__dirname, 'google-services.json');
  if (fs.existsSync(googleServices)) config.android.googleServicesFile = './google-services.json';
  return config;
};
