"""The devices worker (`devices worker`): a separate process that claims
queued `jobs` rows and does the work the API must not wait for — Apple
registration, Ad Hoc profiles and IPA re-signing."""
