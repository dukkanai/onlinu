FROM golang:1.26.4 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go schema.sql ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /tenant .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /tenant /tenant
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/tenant"]
