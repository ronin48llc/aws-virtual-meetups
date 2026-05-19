# Implementation Plan: Custom Domain

## Overview

Configure the custom domain `awsvirtualmeetups.com` for the AWS Virtual Meetups platform by creating a new DnsStack (Route53 + ACM), modifying FrontendStack (CloudFront custom domain), ApiStack (HTTP + WebSocket custom domains, CORS), EmailStack (SES domain identity), updating the CDK app entry point for stack wiring, and updating frontend endpoint URLs. All infrastructure is AWS CDK (JavaScript).

## Tasks

- [x] 1. Create the DnsStack with Route53 hosted zone and ACM certificate
  - [x] 1.1 Create `cdk/lib/dns-stack.js` with Route53 public hosted zone for `awsvirtualmeetups.com`
    - Import `aws-cdk-lib/aws-route53` and `aws-cdk-lib/aws-certificatemanager`
    - Create a `route53.PublicHostedZone` for `awsvirtualmeetups.com`
    - Request an ACM certificate with domain `awsvirtualmeetups.com` and SAN `*.awsvirtualmeetups.com`, validated via DNS against the hosted zone
    - Export `this.hostedZone` and `this.certificate` for cross-stack use
    - Add CloudFormation outputs: `HostedZoneId`, `NameServers` (Fn::Join of NS records), `CertificateArn`
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4_

  - [ ]* 1.2 Write CDK assertion unit tests for DnsStack
    - Create `cdk/test/unit/dns-stack.test.js`
    - Assert template contains `AWS::Route53::HostedZone` with `Name: awsvirtualmeetups.com`
    - Assert template contains `AWS::CertificateManager::Certificate` with correct domain names and DNS validation
    - Assert outputs include `HostedZoneId`, `NameServers`, `CertificateArn`
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 2.4_

- [x] 2. Modify FrontendStack for CloudFront custom domain and DNS records
  - [x] 2.1 Update `cdk/lib/frontend-stack.js` to accept `hostedZone`, `certificate`, and `domainNames` props
    - Add `domainNames` (array) and `certificate` to the CloudFront distribution configuration
    - Add `hostedZone` prop for creating Route53 records
    - Create Route53 A record aliases for `awsvirtualmeetups.com` and `www.awsvirtualmeetups.com` pointing to the CloudFront distribution
    - Use `route53.ARecord` with `route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 2.2 Write CDK assertion unit tests for FrontendStack custom domain changes
    - Update or create assertions in `cdk/test/unit/frontend-stack.test.js`
    - Assert CloudFront distribution has `Aliases` containing both domain names
    - Assert CloudFront distribution has `ViewerCertificate` with the ACM certificate ARN
    - Assert template contains Route53 A records for apex and www
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3. Modify ApiStack for HTTP API and WebSocket API custom domains
  - [x] 3.1 Update `cdk/lib/api-stack.js` to accept `hostedZone` and `certificate` props and create HTTP API custom domain
    - Import `aws-cdk-lib/aws-apigatewayv2` domain name constructs and `aws-cdk-lib/aws-route53`
    - Create a custom domain `api.awsvirtualmeetups.com` using `DomainName` construct with the certificate
    - Create an API mapping from the custom domain to the HTTP API default stage
    - Create a Route53 A record alias for `api.awsvirtualmeetups.com` pointing to the HTTP API custom domain regional endpoint
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 3.2 Add WebSocket API custom domain to `cdk/lib/api-stack.js`
    - Create a custom domain `ws.awsvirtualmeetups.com` using `DomainName` construct with the certificate
    - Create an API mapping from the custom domain to the WebSocket API `prod` stage
    - Create a Route53 A record alias for `ws.awsvirtualmeetups.com` pointing to the WebSocket API custom domain regional endpoint
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 3.3 Update CORS configuration in `cdk/lib/api-stack.js`
    - Change `allowOrigins` from `['*']` to `['https://awsvirtualmeetups.com', 'https://www.awsvirtualmeetups.com']`
    - Retain existing `allowMethods` and `allowHeaders` settings
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ]* 3.4 Write CDK assertion unit tests for ApiStack custom domain changes
    - Create or update `cdk/test/unit/api-stack.test.js`
    - Assert template contains `AWS::ApiGatewayV2::DomainName` for `api.awsvirtualmeetups.com`
    - Assert template contains `AWS::ApiGatewayV2::DomainName` for `ws.awsvirtualmeetups.com`
    - Assert template contains `AWS::ApiGatewayV2::ApiMapping` for both custom domains
    - Assert HTTP API CORS configuration includes the custom domain origins
    - Assert template contains Route53 A records for `api` and `ws` subdomains
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.4, 7.1, 7.2_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Modify EmailStack for SES domain identity and DKIM records
  - [x] 5.1 Update `cdk/lib/email-stack.js` to accept `hostedZone` prop and use domain identity
    - Replace `ses.Identity.email('phannah@thenetwerk.net')` with `ses.Identity.publicHostedZone(hostedZone)`
    - This automatically creates DKIM CNAME records in the hosted zone
    - Update `SES_SENDER` environment variable from `phannah@thenetwerk.net` to `noreply@awsvirtualmeetups.com`
    - Add an MX record for `awsvirtualmeetups.com` pointing to `10 inbound-smtp.us-east-1.amazonaws.com`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 5.2 Write CDK assertion unit tests for EmailStack domain identity changes
    - Update or create assertions in `cdk/test/unit/email-stack.test.js`
    - Assert template contains `AWS::SES::EmailIdentity` with domain identity (not email address)
    - Assert email sender Lambda environment has `SES_SENDER` = `noreply@awsvirtualmeetups.com`
    - Assert template contains MX record for the domain
    - _Requirements: 6.1, 6.2, 6.3, 6.5_

- [x] 6. Update CDK app entry point for stack wiring
  - [x] 6.1 Modify `cdk/bin/app.js` to instantiate DnsStack and wire cross-stack references
    - Import `DnsStack` from `../lib/dns-stack`
    - Instantiate `DnsStack` before FrontendStack, ApiStack, and EmailStack
    - Pass `hostedZone` and `certificate` from DnsStack to FrontendStack props
    - Pass `hostedZone` and `certificate` from DnsStack to ApiStack props
    - Pass `hostedZone` from DnsStack to EmailStack props
    - Add `addDependency(dnsStack)` for FrontendStack, ApiStack, and EmailStack
    - Update `frontendUrl` in EmailStack props to use `https://awsvirtualmeetups.com` instead of the CloudFront distribution domain
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 7. Update frontend endpoint configuration
  - [x] 7.1 Update `frontend/index.html` to use custom domain endpoints
    - Change `window.API_BASE_URL` from `'https://d2fnfkz3hf.execute-api.us-east-1.amazonaws.com'` to `'https://api.awsvirtualmeetups.com'`
    - Change `window.WS_BASE_URL` from `'wss://0b5r6cb8gd.execute-api.us-east-1.amazonaws.com/prod'` to `'wss://ws.awsvirtualmeetups.com'`
    - _Requirements: 8.1, 8.2, 8.4_

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- This is an IaC feature — no property-based tests are needed (CDK assertion tests are used instead)
- **First deployment requires manual NS delegation:** After deploying DnsStack, copy the name server output values and update the domain registrar's NS records before deploying remaining stacks
- Recommended first-time deployment sequence: DnsStack → NS delegation → wait for ACM certificate issuance → deploy remaining stacks
- CORS is tightened from wildcard to specific custom domain origins; during transition, consider temporarily including the CloudFront distribution URL
