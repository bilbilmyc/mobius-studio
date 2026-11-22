use super::capture::{sensitive, Argument, Scrubber, RECORD_LIMIT, TEXT_LIMIT};
use serde::Serialize;
use serde_json::{json, value::RawValue, Value};

#[derive(Clone, Serialize)]
#[serde(untagged)]
pub(super) enum JsonPiece {
    Literal(String),
    Input { path: Vec<Value>, source: Argument },
}

struct Document {
    pieces: Vec<JsonPiece>,
    literal: String,
    remaining: usize,
}
impl Document {
    fn push(&mut self, s: &str) -> Option<()> {
        self.remaining = self.remaining.checked_sub(s.len())?;
        self.literal.push_str(s);
        Some(())
    }
    fn flush(&mut self) {
        if !self.literal.is_empty() {
            self.pieces
                .push(JsonPiece::Literal(std::mem::take(&mut self.literal)));
        }
    }
    fn field(&mut self, value: Argument, path: &[Value]) -> Option<()> {
        if let Argument::Literal(text) = value {
            return self.push(&json!(text).to_string());
        }
        self.remaining = self
            .remaining
            .checked_sub(64 + serde_json::to_string(path).ok()?.len())?;
        self.flush();
        self.pieces.push(JsonPiece::Input {
            path: path.to_vec(),
            source: value,
        });
        Some(())
    }
    fn line(&mut self, depth: usize) -> Option<()> {
        self.push("\n")?;
        self.push(&"  ".repeat(depth))
    }
    fn visit(
        &mut self,
        raw: &RawValue,
        path: &mut Vec<Value>,
        name: &str,
        scrub: &mut Scrubber,
    ) -> Option<()> {
        if path.len() > 64 {
            return None;
        }
        let s = raw.get();
        if sensitive(name) && !s.starts_with('"') {
            return self.field(scrub.binding("VALUE", "json", ""), path);
        }
        match s.as_bytes().first()? {
            b'{' => {
                self.push("{")?;
                let fields: indexmap::IndexMap<String, &RawValue> = serde_json::from_str(s).ok()?;
                if fields.len() > self.remaining / 3 {
                    return None;
                }
                for (i, (key, child)) in fields.iter().enumerate() {
                    if !scrub.safe_name(key) {
                        return None;
                    }
                    if i > 0 {
                        self.push(",")?;
                    }
                    self.line(path.len() + 1)?;
                    self.push(&json!(key).to_string())?;
                    self.push(": ")?;
                    path.push(json!(key));
                    self.visit(child, path, key, scrub)?;
                    path.pop();
                }
                if !fields.is_empty() {
                    self.line(path.len())?;
                }
                self.push("}")
            }
            b'[' => {
                self.push("[")?;
                let items: Vec<&RawValue> = serde_json::from_str(s).ok()?;
                if items.len() > self.remaining / 2 {
                    return None;
                }
                for (i, child) in items.iter().enumerate() {
                    if i > 0 {
                        self.push(",")?;
                    }
                    self.line(path.len() + 1)?;
                    path.push(json!(i));
                    self.visit(child, path, name, scrub)?;
                    path.pop();
                }
                if !items.is_empty() {
                    self.line(path.len())?;
                }
                self.push("]")
            }
            b'"' => {
                // Unescaped data URIs borrow the request bytes, regardless of image size.
                let v = if let Ok(text) = serde_json::from_str::<&str>(s) {
                    scrub.text(name, text)
                } else if s.len() > TEXT_LIMIT * 6 {
                    scrub.binding("VALUE", "text", "")
                } else {
                    scrub.text(name, &serde_json::from_str::<String>(s).ok()?)
                };
                self.field(v, path)
            }
            // Preserve the wire digits, including seeds too large for a JavaScript Number.
            _ => self.push(s),
        }
    }
}
pub(super) fn capture(bytes: &[u8], scrub: &mut Scrubber) -> Option<Vec<JsonPiece>> {
    let raw = serde_json::from_slice::<&RawValue>(bytes).ok()?;
    let mut doc = Document {
        pieces: vec![],
        literal: String::new(),
        remaining: RECORD_LIMIT,
    };
    doc.visit(raw, &mut vec![], "", scrub)?;
    doc.flush();
    Some(doc.pieces)
}
