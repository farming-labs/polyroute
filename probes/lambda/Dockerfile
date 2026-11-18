FROM public.ecr.aws/lambda/provided@sha256:33df7155c46bef0c6768e2388c3c9ade2293662f46afdbdc5501ef91fafd2a81 AS build
RUN dnf install -y gcc gcc-c++ make
RUN curl --fail --silent --show-error --location https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init --output /tmp/rustup-init \
    && echo '20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c  /tmp/rustup-init' | sha256sum --check \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --profile minimal --default-toolchain 1.99.1 --component rustfmt --component clippy
ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /build/probes/lambda
COPY probes/lambda/Cargo.toml probes/lambda/Cargo.lock probes/lambda/policy-cases.json ./
COPY probes/lambda/src ./src
COPY packages/polyroute-wasmtime/src/python_http.rs /build/packages/polyroute-wasmtime/src/python_http.rs
RUN cargo fmt --all --check \
    && rustfmt --edition 2024 --check src/core.rs src/outbound.rs /build/packages/polyroute-wasmtime/src/python_http.rs \
    && cargo clippy --release --all-targets --locked -- -D warnings \
    && cargo test --release --locked \
    && cargo build --release --locked
RUN mkdir /artifact && cp target/release/polyroute-lambda-probe /artifact/polyroute-lambda \
    && ldd /artifact/polyroute-lambda > /artifact/shared-libraries.txt \
    && sha256sum /artifact/polyroute-lambda > /artifact/host.sha256
FROM scratch AS artifact
COPY --from=build /artifact/ /
