variable "ext_port" {
  description = "The external port for Nginx"
  type        = number
  default     = 8000
}

variable "flux_git_repository_url" {
  description = "Git repository URL used by Flux GitRepository."
  type        = string
  default     = "https://github.com/iseeanoob/to-do-list"
}

variable "flux_git_branch" {
  description = "Git branch used by Flux GitRepository."
  type        = string
  default     = "main"
}

variable "flux_cluster_path" {
  description = "Repository path (without leading ./) where cluster Flux manifests are stored."
  type        = string
  default     = "clusters/my-cluster"
}

variable "flux_git_http_username" {
  description = "HTTP basic auth username for Flux Git access."
  type        = string
  default     = ""
}

variable "flux_git_http_password" {
  description = "HTTP basic auth password or token for Flux Git access."
  type        = string
  default     = ""
  sensitive   = true
}
