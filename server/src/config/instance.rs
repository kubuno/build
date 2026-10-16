//! Instance-wide settings of the build module, as the administrator left them in
//! the console.
//!
//! Declared by `module.toml`'s `[[settings]]` blocks, stored in `core.settings`,
//! and read back here through `/internal/modules/build/settings` - a module owns
//! its own schema and cannot read the core's tables, and a background refresher
//! has no user token for the public config route. The module is named in the URL
//! (not derived from the secret) so the read works whether the instance shares
//! one master secret between modules or issues a derived one per module.
//!
//! Only `max_document_bytes` lives here: it is the module's single SERVER-side
//! lever, enforced in `services::content_files` (the one write path of the
//! Architect and CAO3D models). The other two settings the manifest declares -
//! the default unit and the auto-save interval - describe CLIENT behaviour and
//! are marked `public = true` so the front end reads them from
//! `/api/v1/config`; the backend has nothing to do with them, so it does not
//! pretend to hold them.
//!
//! The size is exposed and stored in BYTES: the enforcement point compares a
//! byte count directly, so keeping the unit identical avoids a hidden
//! conversion.

use serde_json::Value;

/// Compiled default ceiling on a saved model, in bytes (50 MiB).
const DEFAULT_MAX_DOCUMENT_BYTES: u64 = 52_428_800;

#[derive(Debug, Clone)]
pub struct InstanceConfig {
    /// Ceiling, in BYTES, on the gzipped content of a single saved model.
    pub max_document_bytes: u64,
}

impl Default for InstanceConfig {
    fn default() -> Self {
        Self { max_document_bytes: DEFAULT_MAX_DOCUMENT_BYTES }
    }
}

impl InstanceConfig {
    /// Maps the core's `{key: value}` object onto the struct. A missing key (an
    /// older core, a cleared field) or an out-of-range number keeps the compiled
    /// default rather than a permissive value.
    pub fn from_settings(settings: &Value) -> Self {
        let d = Self::default();

        // The console stores an `int` as a JSON number, but a value echoed from
        // a text field can arrive as a string - accept both, then range-check
        // against the bounds module.toml declares.
        let v = settings.get("max_document_bytes");
        let max_document_bytes = v
            .and_then(Value::as_u64)
            .or_else(|| v.and_then(Value::as_str).and_then(|s| s.trim().parse::<u64>().ok()))
            .filter(|n| (1_048_576..=2_147_483_648).contains(n))
            .unwrap_or(d.max_document_bytes);

        Self { max_document_bytes }
    }
}

/// Reads the instance settings from the core. Any failure yields `None`, so the
/// caller keeps the values it already had rather than reverting to defaults
/// because the core was briefly unreachable.
pub async fn fetch(http: &reqwest::Client, core_url: &str, secret: &str) -> Option<InstanceConfig> {
    let url = format!("{core_url}/internal/modules/build/settings");
    let resp = http
        .get(&url)
        .header("X-Internal-Secret", secret)
        .send()
        .await
        .map_err(|e| tracing::warn!(error = %e, "Lecture des réglages d'instance build"))
        .ok()?;

    if !resp.status().is_success() {
        tracing::warn!(status = %resp.status(), "Réglages d'instance build refusés par le core");
        return None;
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| tracing::warn!(error = %e, "Réglages d'instance build : réponse illisible"))
        .ok()?;

    Some(InstanceConfig::from_settings(body.get("settings")?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_key_keeps_the_compiled_default() {
        assert_eq!(
            InstanceConfig::from_settings(&json!({})).max_document_bytes,
            DEFAULT_MAX_DOCUMENT_BYTES
        );
    }

    #[test]
    fn value_is_read() {
        assert_eq!(
            InstanceConfig::from_settings(&json!({ "max_document_bytes": 104_857_600 })).max_document_bytes,
            104_857_600
        );
    }

    #[test]
    fn text_encoded_value_is_accepted() {
        assert_eq!(
            InstanceConfig::from_settings(&json!({ "max_document_bytes": "104857600" })).max_document_bytes,
            104_857_600
        );
    }

    #[test]
    fn out_of_range_falls_back() {
        for bad in [json!(0), json!(-5), json!(9_999_999_999_999i64)] {
            assert_eq!(
                InstanceConfig::from_settings(&json!({ "max_document_bytes": bad })).max_document_bytes,
                DEFAULT_MAX_DOCUMENT_BYTES
            );
        }
    }
}
