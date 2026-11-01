//! Product identity shared by the shell's modules.
//!
//! The release driver sets `HARNESS_CN_PRODUCT` before cargo compiles, and `option_env!` reads it at
//! compile time, so a branded build carries its name with no runtime configuration: an installed
//! application has no environment to inherit one from. Building without the variable keeps the
//! historical `Harness-CN` identity.

/// Product name baked into this binary, e.g. `Harness-CN` or `HarScience`.
pub const PRODUCT_NAME: &str = match option_env!("HARNESS_CN_PRODUCT") {
    Some(name) => name,
    None => "Harness-CN",
};