const APP_MODES = { MULTI: 'MULTI' }

const MULTI_ENV_CONFIG = {
  development: {
    GRAPHQL_URL: 'https://aws-server-v2.enatega.com/graphql',
    WS_GRAPHQL_URL: 'wss://aws-server-v2.enatega.com/graphql',
    SERVER_URL: 'https://aws-server-v2.enatega.com/graphql',
    SERVER_REST_URL: 'https://aws-server-v2.enatega.com/',
    // GRAPHQL_URL: 'https://backup-server.enatega.com/graphql',
    // WS_GRAPHQL_URL: 'wss://backup-server.enatega.com/graphql',
    // SERVER_URL: 'https://backup-server.enatega.com/graphql',
    // SERVER_REST_URL: 'https://backup-server.enatega.com/',
    // GRAPHQL_URL: 'http://192.168.1.175:8001/graphql',
    // WS_GRAPHQL_URL: 'wss://192.168.1.175:8001/graphql',
    // SERVER_URL: 'http://192.168.1.175:8001/graphql',
    // SERVER_REST_URL: 'http://192.168.1.175:8001/',
    CLARITY_ENABLED: false
  },
  staging: {
    GRAPHQL_URL: 'https://aws-server-v2.enatega.com/graphql',
    WS_GRAPHQL_URL: 'wss://aws-server-v2.enatega.com/graphql',
    SERVER_URL: 'https://aws-server-v2.enatega.com/graphql',
    SERVER_REST_URL: 'https://aws-server-v2.enatega.com/',
    // GRAPHQL_URL: 'https://backup-server.enatega.com/graphql',
    // WS_GRAPHQL_URL: 'wss://backup-server.enatega.com/graphql',
    // SERVER_URL: 'https://backup-server.enatega.com/graphql',
    // SERVER_REST_URL: 'https://backup-server.enatega.com/',
    // GRAPHQL_URL: 'http://192.168.1.175:8001/graphql',
    // WS_GRAPHQL_URL: 'wss://192.168.1.175:8001/graphql',
    // SERVER_URL: 'http://192.168.1.175:8001/graphql',
    // SERVER_REST_URL: 'http://192.168.1.175:8001/',
    CLARITY_ENABLED: true
  },
  production: {
    GRAPHQL_URL: 'https://aws-server-v2.enatega.com/graphql',
    WS_GRAPHQL_URL: 'wss://aws-server-v2.enatega.com/graphql',
    SERVER_URL: 'https://aws-server-v2.enatega.com/graphql',
    SERVER_REST_URL: 'https://aws-server-v2.enatega.com/',
    // GRAPHQL_URL: 'https://backup-server.enatega.com/graphql',
    // WS_GRAPHQL_URL: 'wss://backup-server.enatega.com/graphql',
    // SERVER_URL: 'https://backup-server.enatega.com/graphql',
    // SERVER_REST_URL: 'https://backup-server.enatega.com/',
    // GRAPHQL_URL: 'http://192.168.1.175:8001/graphql',
    // WS_GRAPHQL_URL: 'wss://192.168.1.175:8001/graphql',
    // SERVER_URL: 'http://192.168.1.175:8001/graphql',
    // SERVER_REST_URL: 'http://192.168.1.175:8001/',
    CLARITY_ENABLED: true
  }
}

const normalizeEnvironment = (env) => {
  if (env === 'production' || env === 'staging') return env
  return 'development'
}

const getEnvironmentConfig = (env, mode = APP_MODES.MULTI) => {
  const environment = normalizeEnvironment(env)


  return {
    ...MULTI_ENV_CONFIG[environment],
    PUBLIC_ACCESS_REQUIRED: true
  }
}

module.exports = {
  ENV_CONFIG: MULTI_ENV_CONFIG,
  MULTI_ENV_CONFIG,
  getEnvironmentConfig,
  normalizeEnvironment
}
