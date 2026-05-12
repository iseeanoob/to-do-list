#!/bin/bash

START=$(date +%s)

terraform destroy -auto-approve

STATUS=$?

END=$(date +%s)
DURATION=$((END - START))

cat <<EOF | curl --data-binary @- http://localhost:9091/metrics/job/terraform
terraform_destroy_duration_seconds $DURATION
terraform_destroy_status $STATUS
terraform_destroy_last_run $(date +%s)
EOF
