#!/bin/bash

START=$(date +%s)

terraform apply -auto-approve
STATUS=$?

END=$(date +%s)
DURATION=$((END - START))

cat <<EOF | curl --data-binary @- http://localhost:9091/metrics/job/terraform
terraform_apply_duration_seconds $DURATION
terraform_apply_status $STATUS
terraform_apply_last_run $(date +%s)
EOF