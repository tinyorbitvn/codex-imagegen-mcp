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
