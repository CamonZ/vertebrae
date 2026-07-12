use serde_json::{json, Value};

use crate::types::PermissionMode;

#[derive(Clone, Copy, Default)]
pub(super) struct CodexPermissionSettings {
    approval_policy: Option<&'static str>,
    permissions: Option<&'static str>,
}

impl CodexPermissionSettings {
    pub(super) fn from_permission_mode(permission_mode: Option<&PermissionMode>) -> Self {
        match permission_mode {
            Some(PermissionMode::AcceptEdits) => Self {
                approval_policy: Some("on-request"),
                permissions: Some(":workspace"),
            },
            Some(PermissionMode::Auto) => Self {
                approval_policy: Some("on-failure"),
                permissions: Some(":workspace"),
            },
            Some(PermissionMode::BypassPermissions) => Self {
                approval_policy: Some("never"),
                permissions: Some(":danger-full-access"),
            },
            Some(PermissionMode::Default) => Self {
                approval_policy: Some("on-request"),
                permissions: Some(":read-only"),
            },
            Some(PermissionMode::DontAsk) => Self {
                approval_policy: Some("never"),
                permissions: Some(":workspace"),
            },
            Some(PermissionMode::Plan) => Self {
                approval_policy: Some("never"),
                permissions: Some(":read-only"),
            },
            None => Self::default(),
        }
    }

    pub(super) fn apply_to_params(self, params: &mut Value) {
        if let Some(approval_policy) = self.approval_policy {
            params["approvalPolicy"] = json!(approval_policy);
        }
        if let Some(permissions) = self.permissions {
            params["permissions"] = json!(permissions);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn params_for(permission_mode: PermissionMode) -> Value {
        let mut params = json!({});
        CodexPermissionSettings::from_permission_mode(Some(&permission_mode))
            .apply_to_params(&mut params);
        params
    }

    #[test]
    fn visible_codex_permission_profiles_keep_their_app_server_mappings() {
        assert_eq!(
            params_for(PermissionMode::Default),
            json!({ "approvalPolicy": "on-request", "permissions": ":read-only" })
        );
        assert_eq!(
            params_for(PermissionMode::Auto),
            json!({ "approvalPolicy": "on-failure", "permissions": ":workspace" })
        );
        assert_eq!(
            params_for(PermissionMode::BypassPermissions),
            json!({ "approvalPolicy": "never", "permissions": ":danger-full-access" })
        );
    }
}
