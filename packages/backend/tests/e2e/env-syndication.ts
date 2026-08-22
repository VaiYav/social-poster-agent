// P1-10: Set syndication feature flags before AppModule is loaded.
// AppModule reads SYNDICATION_ENABLED at module-load time, so this must run
// as an early side-effect import in the E2E test that loads AppModule.
process.env.SYNDICATION_ENABLED = "true";
