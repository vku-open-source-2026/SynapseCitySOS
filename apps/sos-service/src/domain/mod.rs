// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Pure SOS business-domain modules.
//!
//! This tree is a dependency-free port of the corresponding TypeScript
//! modules. It deliberately contains no HTTP, database, scheduler or model
//! client code: callers load records through the Tier-2 capabilities API and
//! pass them in as [`serde_json::Map`] values.

pub mod after_action;
pub mod eop;
pub mod error;
pub mod filters;
pub mod geo;
pub mod hazards;
pub mod mutual_aid;
pub mod optimizer;
pub mod sitrep;
pub mod vndms;

pub use error::DomainError;
pub use filters::Data;
