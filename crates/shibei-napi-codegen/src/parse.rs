//! syn-based parser for `#[shibei_napi]` functions.

use syn::{Attribute, FnArg, Pat, ReturnType, Type};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Sync,
    Async,
    Event,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScalarType {
    I32,
    I64,
    Bool,
    String,
    VoidReturn,
}

#[derive(Debug, Clone)]
pub struct Arg {
    pub rust_name: String,
    pub js_name: String,
    pub ty: ScalarType,
}

#[derive(Debug, Clone)]
pub struct Command {
    pub rust_ident: String,
    pub js_name: String,
    pub kind: Kind,
    pub args: Vec<Arg>,
    /// For sync/async: concrete return scalar (String / i32 / ...).
    /// For event: the callback payload type (what the fn's ThreadsafeCallback<T>
    /// parameter holds).
    pub ret: ScalarType,
}

pub fn parse_commands(source: &str) -> Result<Vec<Command>, String> {
    let file = syn::parse_file(source).map_err(|e| format!("syn parse: {e}"))?;
    let mut out = Vec::new();

    for item in file.items {
        if let syn::Item::Fn(f) = item {
            if let Some(kind) = shibei_napi_kind(&f.attrs) {
                out.push(parse_fn(&f, kind)?);
            }
        }
    }
    Ok(out)
}

/// Returns Some(kind) if the item carries #[shibei_napi] / #[shibei_napi(async)]
/// / #[shibei_napi(event)]; None otherwise.
fn shibei_napi_kind(attrs: &[Attribute]) -> Option<Kind> {
    for a in attrs {
        let segs: Vec<String> =
            a.path().segments.iter().map(|s| s.ident.to_string()).collect();
        let is_match = segs.last().map(|s| s == "shibei_napi").unwrap_or(false);
        if !is_match {
            continue;
        }
        // Parse the parens content: either empty, `async`, or `event`.
        let mut kind = Kind::Sync;
        if matches!(a.meta, syn::Meta::List(_)) {
            let _ = a.parse_nested_meta(|nested| {
                if nested.path.is_ident("async") {
                    kind = Kind::Async;
                } else if nested.path.is_ident("event") {
                    kind = Kind::Event;
                }
                Ok(())
            });
        }
        return Some(kind);
    }
    None
}

fn parse_fn(f: &syn::ItemFn, kind: Kind) -> Result<Command, String> {
    let rust_ident = f.sig.ident.to_string();
    let js_name = snake_to_camel(&rust_ident);

    let mut args = Vec::new();
    for input in &f.sig.inputs {
        let FnArg::Typed(pat) = input else {
            return Err(format!("{rust_ident}: self argument not supported"));
        };
        let rust_name = match &*pat.pat {
            Pat::Ident(pi) => pi.ident.to_string(),
            _ => return Err(format!("{rust_ident}: only plain identifier patterns supported")),
        };
        // For event fns the `cb` parameter wraps `ThreadsafeCallback<T>`; we
        // special-case it below. Other args must be scalars.
        if kind == Kind::Event && rust_name == "cb" {
            continue;
        }
        let ty = rust_type_to_scalar(&pat.ty)
            .ok_or_else(|| format!("{rust_ident}: unsupported argument type for `{rust_name}`"))?;
        args.push(Arg {
            js_name: snake_to_camel(&rust_name),
            rust_name,
            ty,
        });
    }

    // Return: for sync/async the return type is the scalar directly (String, i32)
    // or `Result<T, String>`. For event it's a `Subscription` marker and the
    // callback payload is the single type param of ThreadsafeCallback.
    let ret = match kind {
        Kind::Sync | Kind::Async => return_scalar(&f.sig.output)
            .ok_or_else(|| format!("{rust_ident}: unsupported return type"))?,
        Kind::Event => event_payload_type(f)
            .ok_or_else(|| format!("{rust_ident}: expected a `cb: ThreadsafeCallback<T>` parameter"))?,
    };

    Ok(Command {
        rust_ident,
        js_name,
        kind,
        args,
        ret,
    })
}

fn rust_type_to_scalar(ty: &Type) -> Option<ScalarType> {
    let last = type_last_segment(ty)?;
    match last.as_str() {
        "i32" => Some(ScalarType::I32),
        "i64" => Some(ScalarType::I64),
        "bool" => Some(ScalarType::Bool),
        "String" | "str" => Some(ScalarType::String),
        _ => None,
    }
}

fn type_last_segment(ty: &Type) -> Option<String> {
    match ty {
        Type::Path(p) => p.path.segments.last().map(|s| s.ident.to_string()),
        Type::Reference(r) => type_last_segment(&r.elem),
        _ => None,
    }
}

fn return_scalar(out: &ReturnType) -> Option<ScalarType> {
    match out {
        ReturnType::Default => Some(ScalarType::VoidReturn),
        ReturnType::Type(_, ty) => {
            // Result<T, _> unwraps to T for the codegen side; errors get
            // formatted to a string and packaged per-kind downstream.
            if let Type::Path(p) = &**ty {
                if let Some(seg) = p.path.segments.last() {
                    if seg.ident == "Result" {
                        if let syn::PathArguments::AngleBracketed(args) = &seg.arguments {
                            if let Some(syn::GenericArgument::Type(inner)) = args.args.first() {
                                return rust_type_to_scalar(inner);
                            }
                        }
                    }
                }
            }
            rust_type_to_scalar(ty)
        }
    }
}

fn event_payload_type(f: &syn::ItemFn) -> Option<ScalarType> {
    for input in &f.sig.inputs {
        let FnArg::Typed(pat) = input else { continue };
        let Pat::Ident(pi) = &*pat.pat else { continue };
        if pi.ident != "cb" {
            continue;
        }
        if let Type::Path(p) = &*pat.ty {
            let seg = p.path.segments.last()?;
            if seg.ident == "ThreadsafeCallback" {
                if let syn::PathArguments::AngleBracketed(args) = &seg.arguments {
                    if let Some(syn::GenericArgument::Type(inner)) = args.args.first() {
                        return rust_type_to_scalar(inner);
                    }
                }
            }
        }
    }
    None
}

fn snake_to_camel(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut upper_next = false;
    for c in s.chars() {
        if c == '_' {
            upper_next = true;
            continue;
        }
        if upper_next {
            out.extend(c.to_uppercase());
            upper_next = false;
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snake_to_camel_works() {
        assert_eq!(snake_to_camel("hello"), "hello");
        assert_eq!(snake_to_camel("echo_async"), "echoAsync");
        assert_eq!(snake_to_camel("s3_smoke_test"), "s3SmokeTest");
        assert_eq!(snake_to_camel("on_tick"), "onTick");
    }

    #[test]
    fn parses_sync_fn() {
        let src = r#"
            #[shibei_napi]
            pub fn hello() -> String { unimplemented!() }
        "#;
        let cmds = parse_commands(src).unwrap();
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].rust_ident, "hello");
        assert_eq!(cmds[0].js_name, "hello");
        assert_eq!(cmds[0].kind, Kind::Sync);
        assert!(cmds[0].args.is_empty());
        assert_eq!(cmds[0].ret, ScalarType::String);
    }

    #[test]
    fn parses_async_fn_with_args() {
        let src = r#"
            #[shibei_napi(async)]
            pub async fn echo_async(text: String) -> Result<String, String> { unimplemented!() }
        "#;
        let cmds = parse_commands(src).unwrap();
        assert_eq!(cmds[0].kind, Kind::Async);
        assert_eq!(cmds[0].args.len(), 1);
        assert_eq!(cmds[0].args[0].rust_name, "text");
        assert_eq!(cmds[0].args[0].js_name, "text");
        assert_eq!(cmds[0].args[0].ty, ScalarType::String);
        assert_eq!(cmds[0].ret, ScalarType::String);
    }

    #[test]
    fn parses_event_fn() {
        let src = r#"
            #[shibei_napi(event)]
            pub fn on_tick(interval_ms: i64, cb: ThreadsafeCallback<i64>) -> Subscription {
                unimplemented!()
            }
        "#;
        let cmds = parse_commands(src).unwrap();
        assert_eq!(cmds[0].kind, Kind::Event);
        // cb is stripped; interval_ms is the single user-visible arg.
        assert_eq!(cmds[0].args.len(), 1);
        assert_eq!(cmds[0].args[0].rust_name, "interval_ms");
        assert_eq!(cmds[0].args[0].js_name, "intervalMs");
        assert_eq!(cmds[0].ret, ScalarType::I64);
    }

    #[test]
    fn ignores_unannotated_fn() {
        let src = r#"
            pub fn helper() -> i32 { 0 }
        "#;
        assert_eq!(parse_commands(src).unwrap().len(), 0);
    }
}
