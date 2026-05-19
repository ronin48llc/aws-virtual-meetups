# Requirements Document

## Introduction

This feature configures the custom domain `awsvirtualmeetups.com` for the AWS Virtual Meetups platform. It covers DNS management via Route53, SSL certificate provisioning via ACM, custom domain mapping for CloudFront (frontend), HTTP API Gateway, and WebSocket API, SES domain identity verification for branded email sending, CORS updates, and frontend endpoint configuration. All infrastructure is managed through AWS CDK.

## Glossary

- **CDK_App**: The AWS CDK application that synthesizes and deploys all platform stacks
- **DNS_Stack**: A new CDK stack responsible for Route53 hosted zone, ACM certificate, and DNS record management
- **Frontend_Stack**: The existing CDK stack managing S3 bucket and CloudFront distribution for the SPA
- **API_Stack**: The existing CDK stack managing HTTP API Gateway, WebSocket API, and Lambda functions
- **Email_Stack**: The existing CDK stack managing SES identity and email sender Lambda
- **Hosted_Zone**: A Route53 hosted zone that contains DNS records for the domain `awsvirtualmeetups.com`
- **ACM_Certificate**: An AWS Certificate Manager SSL/TLS certificate covering `awsvirtualmeetups.com` and `*.awsvirtualmeetups.com`
- **CloudFront_Distribution**: The existing CloudFront distribution serving the frontend SPA
- **HTTP_API**: The existing HTTP API Gateway serving REST endpoints
- **WebSocket_API**: The existing WebSocket API Gateway for real-time communication
- **SES_Domain_Identity**: An Amazon SES domain identity for `awsvirtualmeetups.com`
- **Frontend_App**: The client-side JavaScript application served by CloudFront

## Requirements

### Requirement 1: Route53 Hosted Zone

**User Story:** As a platform operator, I want a Route53 hosted zone for `awsvirtualmeetups.com`, so that all DNS records for the platform are managed as infrastructure-as-code.

#### Acceptance Criteria

1. THE DNS_Stack SHALL create a Route53 public hosted zone for the domain `awsvirtualmeetups.com`
2. THE DNS_Stack SHALL export the hosted zone ID and name servers as CloudFormation outputs
3. WHEN the stack is deployed, THE DNS_Stack SHALL produce a list of name server records that can be configured at the domain registrar

### Requirement 2: ACM Certificate

**User Story:** As a platform operator, I want an SSL/TLS certificate covering `awsvirtualmeetups.com` and `*.awsvirtualmeetups.com`, so that all platform endpoints are served over HTTPS.

#### Acceptance Criteria

1. THE DNS_Stack SHALL request an ACM certificate with the primary domain `awsvirtualmeetups.com` and Subject Alternative Name `*.awsvirtualmeetups.com`
2. THE DNS_Stack SHALL validate the ACM certificate using DNS validation records in the Route53 hosted zone
3. THE ACM_Certificate SHALL be provisioned in the `us-east-1` region to support CloudFront distribution association
4. WHEN the certificate is issued, THE DNS_Stack SHALL export the certificate ARN as a CloudFormation output

### Requirement 3: CloudFront Custom Domain

**User Story:** As a user, I want to access the platform at `awsvirtualmeetups.com` and `www.awsvirtualmeetups.com`, so that the platform has a professional branded URL.

#### Acceptance Criteria

1. THE Frontend_Stack SHALL configure the CloudFront_Distribution with alternate domain names `awsvirtualmeetups.com` and `www.awsvirtualmeetups.com`
2. THE Frontend_Stack SHALL associate the ACM_Certificate with the CloudFront_Distribution for TLS termination
3. THE DNS_Stack SHALL create an A record (alias) pointing `awsvirtualmeetups.com` to the CloudFront_Distribution
4. THE DNS_Stack SHALL create an A record (alias) pointing `www.awsvirtualmeetups.com` to the CloudFront_Distribution
5. WHEN a user navigates to `https://awsvirtualmeetups.com`, THE CloudFront_Distribution SHALL serve the frontend SPA

### Requirement 4: HTTP API Gateway Custom Domain

**User Story:** As a frontend developer, I want the REST API available at `api.awsvirtualmeetups.com`, so that API calls use a clean, branded endpoint.

#### Acceptance Criteria

1. THE API_Stack SHALL create a custom domain name `api.awsvirtualmeetups.com` for the HTTP_API
2. THE API_Stack SHALL associate the ACM_Certificate with the custom domain name for TLS termination
3. THE API_Stack SHALL create an API mapping from the custom domain to the HTTP_API default stage
4. THE DNS_Stack SHALL create an A record (alias) pointing `api.awsvirtualmeetups.com` to the HTTP API custom domain regional endpoint
5. WHEN a client sends a request to `https://api.awsvirtualmeetups.com/events`, THE HTTP_API SHALL route the request to the appropriate Lambda function

### Requirement 5: WebSocket API Custom Domain

**User Story:** As a frontend developer, I want the WebSocket API available at `ws.awsvirtualmeetups.com`, so that real-time connections use a branded endpoint.

#### Acceptance Criteria

1. THE API_Stack SHALL create a custom domain name `ws.awsvirtualmeetups.com` for the WebSocket_API
2. THE API_Stack SHALL associate the ACM_Certificate with the WebSocket custom domain name for TLS termination
3. THE API_Stack SHALL create an API mapping from the custom domain to the WebSocket_API `prod` stage
4. THE DNS_Stack SHALL create an A record (alias) pointing `ws.awsvirtualmeetups.com` to the WebSocket API custom domain regional endpoint
5. WHEN a client opens a WebSocket connection to `wss://ws.awsvirtualmeetups.com`, THE WebSocket_API SHALL establish the connection and route messages

### Requirement 6: SES Domain Identity

**User Story:** As a platform operator, I want emails sent from `noreply@awsvirtualmeetups.com`, so that notification emails appear professional and trustworthy to recipients.

#### Acceptance Criteria

1. THE Email_Stack SHALL create an SES domain identity for `awsvirtualmeetups.com`
2. THE Email_Stack SHALL configure DKIM signing by adding the required CNAME records to the Route53 hosted zone
3. THE Email_Stack SHALL update the email sender Lambda environment variable `SES_SENDER` to `noreply@awsvirtualmeetups.com`
4. WHEN the domain identity is verified, THE Email_Stack SHALL remove or deprecate the previous email-address-based SES identity
5. THE DNS_Stack SHALL create an MX record for `awsvirtualmeetups.com` pointing to the SES inbound SMTP endpoint for the deployment region

### Requirement 7: CORS Configuration

**User Story:** As a frontend developer, I want the API Gateway CORS configuration to allow requests from the custom domain origins, so that browser-based API calls succeed without cross-origin errors.

#### Acceptance Criteria

1. THE API_Stack SHALL configure the HTTP_API CORS allowed origins to include `https://awsvirtualmeetups.com` and `https://www.awsvirtualmeetups.com`
2. THE API_Stack SHALL retain existing CORS allowed methods (`GET`, `POST`, `PUT`, `DELETE`, `OPTIONS`) and allowed headers (`Content-Type`, `Authorization`)
3. WHEN a browser sends a preflight OPTIONS request from `https://awsvirtualmeetups.com`, THE HTTP_API SHALL respond with appropriate CORS headers permitting the request

### Requirement 8: Frontend Endpoint Configuration

**User Story:** As a frontend developer, I want the frontend application to use `https://api.awsvirtualmeetups.com` and `wss://ws.awsvirtualmeetups.com` as its API and WebSocket endpoints, so that the application communicates through the custom domain.

#### Acceptance Criteria

1. THE Frontend_App SHALL set `window.API_BASE_URL` to `https://api.awsvirtualmeetups.com`
2. THE Frontend_App SHALL set `window.WS_BASE_URL` to `wss://ws.awsvirtualmeetups.com`
3. THE Frontend_Stack SHALL inject the API and WebSocket endpoint URLs into the frontend configuration during deployment
4. WHEN the frontend is loaded in a browser, THE Frontend_App SHALL use the custom domain endpoints for all API and WebSocket communication

### Requirement 9: CDK Stack Organization

**User Story:** As a platform operator, I want the domain infrastructure managed in a dedicated CDK stack with proper cross-stack references, so that domain resources can be deployed and updated independently.

#### Acceptance Criteria

1. THE CDK_App SHALL define a new `DnsStack` that encapsulates the hosted zone, ACM certificate, and all DNS records
2. THE DnsStack SHALL be deployed before the Frontend_Stack, API_Stack, and Email_Stack when domain resources are referenced
3. THE DnsStack SHALL accept the CloudFront distribution domain name, HTTP API custom domain, and WebSocket API custom domain as input properties for DNS record creation
4. THE CDK_App SHALL pass the hosted zone and certificate references from DnsStack to dependent stacks via cross-stack properties
5. IF the ACM certificate is not yet validated, THEN THE CDK_App SHALL document that initial deployment requires manual name server delegation at the domain registrar before certificate validation completes
