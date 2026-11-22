use super::capture::{Field, Scrubber};
use reqwest::{multipart, RequestBuilder};

pub(crate) struct Outgoing {
    pub(super) wire: RequestBuilder,
    pub(super) form: Option<Vec<Field>>,
}
impl From<RequestBuilder> for Outgoing {
    fn from(wire: RequestBuilder) -> Self {
        Self { wire, form: None }
    }
}

// Build the sendable stream and its description together. Never consume or clone a file stream.
pub(crate) struct Form<'a> {
    wire: multipart::Form,
    capture: Option<(Scrubber<'a>, Vec<Field>)>,
}
impl<'a> Form<'a> {
    pub fn new(key: &'a str) -> Self {
        Self {
            wire: multipart::Form::new(),
            capture: super::epoch().map(|_| (Scrubber::new(key), Vec::new())),
        }
    }
    pub fn text(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        let name = name.into();
        let value = value.into();
        if let Some((scrub, fields)) = &mut self.capture {
            fields.push(Field::Text {
                name: name.clone(),
                value: scrub.text(&name, &value),
            });
        }
        self.wire = self.wire.text(name, value);
        self
    }
    pub fn file(mut self, name: &str, part: multipart::Part, filename: &str, mime: &str) -> Self {
        if let Some((scrub, fields)) = &mut self.capture {
            fields.push(Field::File {
                name: name.into(),
                file: scrub.binding("FILE", "file", ""),
                filename: scrub.metadata("filename", filename),
                mime: mime.into(),
            });
        }
        self.wire = self.wire.part(name.to_owned(), part);
        self
    }
    pub fn attach(self, request: RequestBuilder) -> Outgoing {
        let form = self.capture.and_then(|(scrub, fields)| {
            fields
                .iter()
                .all(|f| scrub.safe_name(f.name()))
                .then_some(fields)
        });
        Outgoing {
            wire: request.multipart(self.wire),
            form,
        }
    }
}
