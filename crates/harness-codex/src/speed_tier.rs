use vertebrae_harness_core::{SpeedTier, SpeedTierStatus};

pub(crate) fn service_tier(value: Option<&str>) -> Option<SpeedTier> {
    match value {
        Some("priority") => Some(SpeedTier::Fast),
        Some("default") => Some(SpeedTier::Default),
        _ => None,
    }
}

pub(crate) fn requested_status(requested: Option<SpeedTier>) -> Option<SpeedTierStatus> {
    requested.map(|tier| SpeedTierStatus {
        requested: Some(tier),
        active: None,
        eligible: true,
        available: true,
        diagnostic: None,
    })
}
