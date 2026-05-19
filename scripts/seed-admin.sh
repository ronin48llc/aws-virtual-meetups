#!/bin/bash
# Seed script: Creates the admin/organizer user for the Virtual Meetup Platform
# Usage: ./scripts/seed-admin.sh

set -e

PROFILE="911445170957_AWSAdministratorAccess"
REGION="us-east-1"
USER_POOL_ID="us-east-1_Z8YDS0abS"
EMAIL="phannah@thenetwerk.net"
PASSWORD="Mv!k9Xp#2wLqR7nZ"

echo "=== Virtual Meetup Platform — Seed Admin User ==="
echo ""
echo "User Pool: $USER_POOL_ID"
echo "Email:     $EMAIL"
echo ""

# Create the user
echo "Creating user..."
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --user-attributes \
    Name=email,Value="$EMAIL" \
    Name=email_verified,Value=true \
    Name=custom:role,Value=organizer \
  --temporary-password "$PASSWORD" \
  --message-action SUPPRESS \
  --profile "$PROFILE" \
  --region "$REGION" \
  2>&1 && echo "  ✓ User created" || echo "  ⚠ User may already exist"

# Set permanent password (skip the FORCE_CHANGE_PASSWORD state)
echo "Setting permanent password..."
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --password "$PASSWORD" \
  --permanent \
  --profile "$PROFILE" \
  --region "$REGION" \
  2>&1 && echo "  ✓ Password set"

# Confirm the user's email
echo "Confirming email..."
aws cognito-idp admin-update-user-attributes \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email_verified,Value=true \
  --profile "$PROFILE" \
  --region "$REGION" \
  2>&1 && echo "  ✓ Email verified"

echo ""
echo "=== Done ==="
echo ""
echo "You can now sign in at: https://d2hbje3cen4qrx.cloudfront.net"
echo "  Email:    $EMAIL"
echo "  Password: $PASSWORD"
echo "  Role:     organizer"
echo ""
