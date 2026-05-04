use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct FleetCorrelation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wave_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_ref: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::FleetCorrelation;

    #[test]
    fn fleet_correlation_round_trips_snake_case_json_fields() {
        let correlation = FleetCorrelation {
            workspace_id: Some("workspace-a".to_string()),
            plan_id: Some("plan-a".to_string()),
            wave_id: Some("W5".to_string()),
            agent_run_id: Some("agent-run-a".to_string()),
            correlation_id: Some("corr-a".to_string()),
            tool_call_id: Some("tool-call-a".to_string()),
            artifact_ref: Some("artifact-a".to_string()),
        };

        let encoded = serde_json::to_value(&correlation).expect("serialize fleet correlation");

        assert_eq!(encoded["workspace_id"], "workspace-a");
        assert_eq!(encoded["agent_run_id"], "agent-run-a");
        assert_eq!(encoded["tool_call_id"], "tool-call-a");

        let decoded: FleetCorrelation =
            serde_json::from_value(encoded).expect("deserialize fleet correlation");
        assert_eq!(decoded, correlation);
    }
}
