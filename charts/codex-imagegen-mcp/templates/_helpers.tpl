{{/*
Base name, honouring the usual overrides.
*/}}
{{- define "codex-imagegen-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "codex-imagegen-mcp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "codex-imagegen-mcp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "codex-imagegen-mcp.labels" -}}
helm.sh/chart: {{ include "codex-imagegen-mcp.chart" . }}
{{ include "codex-imagegen-mcp.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "codex-imagegen-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "codex-imagegen-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "codex-imagegen-mcp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "codex-imagegen-mcp.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Full image reference for one component.
*/}}
{{- define "codex-imagegen-mcp.image" -}}
{{- $top := index . 0 -}}
{{- $img := index . 1 -}}
{{- $tag := default $top.Chart.AppVersion $img.tag -}}
{{- if $img.registry -}}
{{- printf "%s/%s:%s" $img.registry $img.repository $tag -}}
{{- else -}}
{{- printf "%s:%s" $img.repository $tag -}}
{{- end -}}
{{- end -}}

{{/*
Redis URL: either the one you gave us, or the in-chart evaluation Redis.
*/}}
{{- define "codex-imagegen-mcp.redisUrl" -}}
{{- if .Values.redis.url -}}
{{- .Values.redis.url -}}
{{- else -}}
{{- printf "redis://%s-redis:6379" (include "codex-imagegen-mcp.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "codex-imagegen-mcp.s3SecretName" -}}
{{- if .Values.s3.existingSecret -}}
{{- .Values.s3.existingSecret -}}
{{- else -}}
{{- printf "%s-s3" (include "codex-imagegen-mcp.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
The URL handed back to MCP clients for a generated image. It must resolve
from wherever the client runs, which is why it cannot be derived from the
Service name.
*/}}
{{- define "codex-imagegen-mcp.publicBaseUrl" -}}
{{- if .Values.publicBaseUrl -}}
{{- .Values.publicBaseUrl | trimSuffix "/" -}}
{{- else if .Values.ingress.enabled -}}
{{- $host := (first .Values.ingress.hosts).host -}}
{{- if .Values.ingress.tls -}}https://{{ $host }}{{- else -}}http://{{ $host }}{{- end -}}
{{- else -}}
{{- printf "http://%s.%s.svc:%v" (include "codex-imagegen-mcp.fullname" .) .Release.Namespace .Values.service.port -}}
{{- end -}}
{{- end -}}

{{/*
Environment for one container. Takes (list $ "<role>") so the two split
Deployments cannot drift apart: there is one definition of every variable.
*/}}
{{- define "codex-imagegen-mcp.env" -}}
{{- $ := index . 0 -}}
{{- $role := index . 1 -}}
- name: ROLE
  value: {{ $role | quote }}
- name: PORT
  value: "8080"
- name: PUBLIC_BASE_URL
  value: {{ include "codex-imagegen-mcp.publicBaseUrl" $ | quote }}
{{- if or $.Values.redis.url $.Values.redis.deploy }}
- name: REDIS_URL
  value: {{ include "codex-imagegen-mcp.redisUrl" $ | quote }}
{{- end }}
- name: QUEUE_LIMIT
  value: {{ $.Values.queueLimit | quote }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ $.Values.otlp.endpoint | quote }}
{{- if $.Values.s3.endpoint }}
- name: S3_ENDPOINT
  value: {{ $.Values.s3.endpoint | quote }}
- name: S3_BUCKET
  value: {{ $.Values.s3.bucket | quote }}
- name: S3_REGION
  value: {{ $.Values.s3.region | quote }}
- name: S3_FORCE_PATH_STYLE
  value: {{ $.Values.s3.forcePathStyle | quote }}
- name: S3_PUBLIC_BASE_URL
  value: {{ $.Values.s3.publicBaseUrl | quote }}
- name: S3_SIGNED_URL_TTL_SECONDS
  value: {{ $.Values.s3.signedUrlTtlSeconds | quote }}
- name: AWS_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "codex-imagegen-mcp.s3SecretName" $ }}
      key: AWS_ACCESS_KEY_ID
- name: AWS_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "codex-imagegen-mcp.s3SecretName" $ }}
      key: AWS_SECRET_ACCESS_KEY
{{- else }}
- name: ARTIFACT_DIR
  value: /data/artifacts
{{- end }}
{{- if ne $role "worker" }}
- name: RATE_LIMIT_CREATE_IMAGE_PER_HOUR
  value: {{ $.Values.rateLimit.createImagePerHour | quote }}
- name: RATE_LIMIT_EDIT_IMAGE_PER_HOUR
  value: {{ $.Values.rateLimit.editImagePerHour | quote }}
{{- end }}
{{- if ne $role "mcp" }}
- name: WORKER_CONCURRENCY
  value: {{ $.Values.worker.concurrency | quote }}
- name: JOB_TIMEOUT_SECONDS
  value: {{ $.Values.worker.jobTimeoutSeconds | quote }}
- name: GENERATED_IMAGE_RETENTION_HOURS
  value: {{ $.Values.worker.generatedImageRetentionHours | quote }}
- name: CODEX_HOME
  value: /home/codex/.codex
- name: WORK_DIR
  value: /work/jobs
{{- end }}
{{- end -}}
