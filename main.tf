terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
  }
}

provider "kubernetes" {
  config_path    = "~/.kube/config"
}


resource "kubernetes_namespace_v1" "todo_app" {
  metadata {
    name = "todo-app"
  }
}

resource "kubernetes_deployment_v1" "mysql" {
  metadata {
    name      = "mysql"
    namespace = kubernetes_namespace_v1.todo_app.metadata[0].name
  }

  spec {
    replicas = 1

    selector {
      match_labels = {
        app = "mysql"
      }
    }

    template {
      metadata {
        labels = {
          app = "mysql"
        }
      }

      spec {
        container {
          name  = "mysql"
          image = "mysql:8.4"

          port {
            container_port = 3306
          }

          env {
            name  = "MYSQL_ROOT_PASSWORD"
            value = "rootpass"
          }
          env {
            name  = "MYSQL_DATABASE"
            value = "mydb"
          }
          env {
            name  = "MYSQL_USER"
            value = "iseeanoob"
          }
          env {
            name  = "MYSQL_PASSWORD"
            value = "pass"
          }

          volume_mount {
            name       = "mysql-data"
            mount_path = "/var/lib/mysql"
          }
        }

        volume {
          name = "mysql-data"
          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim_v1.mysql_pvc.metadata[0].name
          }
        }
      }
    }
  }
}

resource "kubernetes_persistent_volume_claim_v1" "mysql_pvc" {
  metadata {
    name      = "mysql-pvc"
    namespace = kubernetes_namespace_v1.todo_app.metadata[0].name
  }

  wait_until_bound = false
  spec {
    access_modes = ["ReadWriteOnce"]

    resources {
      requests = {
        storage = "1Gi"
      }
    }
  }
}

resource "kubernetes_service_v1" "mysql_service" {
  metadata {
    name      = "db"
    namespace = kubernetes_namespace_v1.todo_app.metadata[0].name
  }

  spec {
    selector = {
      app = "mysql"
    }

    port {
      port        = 3306
      target_port = 3306
    }

    type = "ClusterIP"
  }
}

resource "kubernetes_deployment_v1" "todo_app" {
  metadata {
    name      = "todo-app"
    namespace = kubernetes_namespace_v1.todo_app.metadata[0].name
  }

  spec {
    replicas = 1

    selector {
      match_labels = {
        app = "todo-app"
      }
    }

    template {
      metadata {
        labels = {
          app = "todo-app"
        }
      }

      spec {
        container {
          name  = "todo-app"
          image = "iseeanoob/todo-app:latest"
          image_pull_policy = "Always"

          port {
            container_port = 3001
          }

          env {
            name  = "DB_HOST"
            value = "db"
          }
          env {
            name  = "DB_USER"
            value = "iseeanoob"
          }
          env {
            name  = "DB_PASSWORD"
            value = "pass"
          }
          env {
            name  = "DB_NAME"
            value = "mydb"
          }
          env {
            name  = "JWT_SECRET"
            value = "your_jwt_secret"   # change this to something secure
          }
          env {
            name  = "PORT"
            value = "3001"
          }
        }
      }
    }
  }

  depends_on = [kubernetes_deployment_v1.mysql]
}

resource "kubernetes_service_v1" "todo_app_service" {
  metadata {
    name      = "todo-app-service"
    namespace = kubernetes_namespace_v1.todo_app.metadata[0].name
  }

  spec {
    selector = {
      app = "todo-app"
    }

    port {
      port        = 80
      target_port = 3001
      node_port   = 30080
    }

    type = "NodePort"
  }
}

locals {
  flux_cluster_relative_path = trimprefix(var.flux_cluster_path, "./")
  flux_cluster_directory     = "${path.module}/${local.flux_cluster_relative_path}"

  flux_manifest_files = {
    components = replace(replace(file("${local.flux_cluster_directory}/flux-system/gotk-components.yaml"), "1000m", "1"), "pods: \"1000\"", "pods: \"1k\"")
    sync       = file("${local.flux_cluster_directory}/flux-system/gotk-sync.yaml")
  }

  flux_manifest_documents = {
    for name, raw_file_content in local.flux_manifest_files :
    name => [
      for yaml_document in split("\n---\n", "\n${replace(raw_file_content, "\r\n", "\n")}") :
      trimspace(yaml_document)
      if trimspace(replace(yaml_document, "/(?m)^\\s*#.*$/", "")) != ""
    ]
  }

  flux_sync_manifests = [
    for doc in local.flux_manifest_documents.sync :
    yamldecode(doc)
  ]

  flux_components_manifests_raw = [
    for doc in local.flux_manifest_documents.components :
    yamldecode(doc)
  ]

  flux_components_manifests = [
    for manifest in local.flux_components_manifests_raw : jsondecode(
      manifest.kind == "Deployment" ? jsonencode(merge(manifest, {
        spec = merge(manifest.spec, {
          template = merge(manifest.spec.template, {
            spec = merge(manifest.spec.template.spec, {
              containers = [
                for container in try(manifest.spec.template.spec.containers, []) : merge(container,
                  try(container.resources.limits.cpu, null) == "1000m" ? {
                    resources = merge(try(container.resources, {}), {
                      limits = merge(try(container.resources.limits, {}), {
                        cpu = "1"
                      })
                    })
                } : {})
              ]
            })
          })
        })
      })) : (
        manifest.kind == "ResourceQuota" && try(manifest.spec.hard.pods, null) == "1000" ? jsonencode(merge(manifest, {
          spec = merge(manifest.spec, {
            hard = merge(try(manifest.spec.hard, {}), {
              pods = "1k"
            })
          })
        })) : jsonencode(manifest)
      )
    )
  ]

  flux_sync_manifests_overridden = [
    for manifest in local.flux_sync_manifests : jsondecode(
      manifest.kind == "GitRepository" ? jsonencode(merge(manifest, {
        spec = merge(manifest.spec, {
          url = var.flux_git_repository_url
          ref = merge(try(manifest.spec.ref, {}), {
            branch = var.flux_git_branch
          })
        })
      })) : (
        manifest.kind == "Kustomization" ? jsonencode(merge(manifest, {
          spec = merge(manifest.spec, {
            path = "./${local.flux_cluster_relative_path}"
          })
        })) : jsonencode(manifest)
      )
    )
  ]
}

resource "kubernetes_manifest" "flux_components" {
  for_each = {
    for index, manifest in local.flux_components_manifests :
    format("%05d-%s-%s-%s", index, lower(manifest.kind), lower(manifest.metadata.name), lower(try(manifest.metadata.namespace, "cluster"))) => manifest
  }

  manifest = each.value
}

resource "kubernetes_manifest" "flux_sync" {
  for_each = {
    for index, manifest in local.flux_sync_manifests_overridden :
    format("%05d-%s-%s-%s", index, lower(manifest.kind), lower(manifest.metadata.name), lower(try(manifest.metadata.namespace, "cluster"))) => manifest
  }

  manifest = each.value

  depends_on = [kubernetes_manifest.flux_components]
}
