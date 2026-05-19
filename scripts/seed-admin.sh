#!/bin/bash
# Seed script: Creates the admin/organizer user for the Virtual Meetup Platform
# Usage: ./scripts/seed-admin.sh
#
# Required environment variables:
#   AWS_PROFILE   - AWS CLI profile name
#   USER_POOL_ID  - Cognito User Pool ID (from CDK output)
#   ADMIN_EMAIL   - Email address for the admin user
#   ADMIN_PASSWORD - Password for the admin user (min 8 chars, upper+lower+digit)
#
# Optional:
#   AWS_REGION    - AWS region (default: us-east-1)

set -e

# Validate required environment variables
if [ -z "$AWS_PROFILE" ]; then
  echo "ERROR: AWS_PROFILE environment variable is required"
  echo "  Example: export AWS_PROFILE=your-profile-name"
  exit 1
fi

if [ -z "$USER_POOL_ID" ]; then
  echo "ERROR: USER_POOL_ID environment variable is required"
  echo "  Get it from: aws cloudformation describe-stacks --stack-name VirtualMeetup-dev-Auth --query 'Stacks[0].Outputs[?OutputKey==\`UserPoolId\`].OutputValue' --output text"
  exit 1
fi

if [ -z "$ADMIN_EMAIL" ]; then
  echo "ERROR: ADMIN_EMAIL environment variable is required"
  exit 1
fi

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "ERROR: ADMIN_PASSWORD environment variable is required"
  echo "  Must be at least 8 characters with uppercase, lowercase, and digits"
  exit 1
fi

REGION="${AWS_REGION:-us-east-1}"

echo "=== Virtual Meetup Platform — Seed Admin User ==="
echo ""
echo "User Pool: $USER_POOL_ID"
echo "Email:     $ADMIN_EMAIL"
echo "Region:    $REGION"
echo ""

# Create the user
echo "Creating user..."
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --user-attributes \
    Name=email,Value="$ADMIN_EMAIL" \
    Name=email_verified,Value=true \
    Name=custom:role,Value=organizer \
  --temporary-password "$ADMIN_PASSWORD" \
  --message-action SUPPRESS \
  --profile "$AWS_PROFILE" \
  --region "$REGION" \
  2>&1 && echo "  ✓ User created" || echo "  ⚠ User may already exist"

# Set permanent password (skip the FORCE_CHANGE_PASSWORD state)
echo "Setting permanent password..."
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --password "$ADMIN_PASSWORD" \
  --permanent \
  --profile "$AWS_PROFILE" \
  --region "$REGION" \
  2>&1 && echo "  ✓ Password set"

# Confirm the user's email
echo "Confirming email..."
aws cognito-idp admin-update-user-attributes \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --user-attributes Name=email_verified,Value=true \
  --profile "$AWS_PROFILE" \
  --region "$REGION" \
  2>&1 && echo "  ✓ Email verified"

echo ""
echo "=== Done ==="
echo ""
echo "You can now sign in with:"
echo "  Email:    $ADMIN_EMAIL"
echo "  Password: (as provided)"
echo "  Role:     organizer"
echo ""
