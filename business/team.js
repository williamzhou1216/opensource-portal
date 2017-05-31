//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

const common = require('./common');
const wrapError = require('../utils').wrapError;

const githubEntityClassification = require('../data/github-entity-classification.json');
const teamPrimaryProperties = githubEntityClassification.team.keep;
const teamSecondaryProperties = githubEntityClassification.team.strip;

const _ = require('lodash');
const TeamMember = require('./teamMember');
const TeamRepositoryPermission = require('./teamRepositoryPermission');

class Team {
  constructor(organization, entity, getToken, operations) {
    if (!entity || !entity.id) {
      throw new Error('Team instantiation requires an incoming entity, or minimum-set entity containing an id property.');
    }

    this.organization = organization;
    common.assignKnownFields(this, entity, 'team', teamPrimaryProperties, teamSecondaryProperties);

    const privates = _private(this);
    privates.getToken = getToken;
    privates.operations = operations;
  }

  ensureName(callback) {
    if (this.name && this.slug) {
      return callback();
    }
    this.getDetails(callback);
  }

  getDetails(callback) {
    const self = this;
    const token = _private(this).getToken();
    const operations = _private(this).operations;
    const id = this.id;
    if (!id) {
      return callback(new Error('No "id" property associated with the team instance to retrieve the details for.'));
    }
    const parameters = {
      id: id,
    };
    return operations.github.call(token, 'orgs.getTeam', parameters, (error, entity) => {
      if (error) {
        return callback(wrapError(error, 'Could not get details about the team.'));
      }
      common.assignKnownFields(self, entity, 'team', teamPrimaryProperties, teamSecondaryProperties);
      callback(null, entity);
    });
  }

  get isBroadAccessTeam() {
    const teams = this.organization.broadAccessTeams;
    const res = teams.indexOf(this.id);
    return res >= 0;
  }

  get isSystemTeam() {
    const systemTeams = this.organization.systemTeamIds;
    const res = systemTeams.indexOf(this.id);
    return res >= 0;
  }

  delete(callback) {
    const operations = _private(this).operations;
    const token = _private(this).getToken();
    const github = operations.github;

    const parameters = {
      id: this.id,
    };
    github.post(token, 'orgs.deleteTeam', parameters, callback);
  }

  edit(patch, callback) {
    const operations = _private(this).operations;
    const token = _private(this).getToken();
    const github = operations.github;

    const parameters = {
      id: this.id,
    };
    delete patch.id;
    Object.assign(parameters, patch);

    github.post(token, 'orgs.editTeam', parameters, callback);
  }

  removeMembership(username, callback) {
    const operations = _private(this).operations;
    const token = _private(this).getToken();
    const github = operations.github;

    const parameters = {
      id: this.id,
      username: username,
    };
    github.post(token, 'orgs.removeTeamMembership', parameters, callback);
  }

  addMembership(username, options, callback) {
    const operations = _private(this).operations;
    const token = _private(this).getToken();
    const github = operations.github;
    if (!callback && typeof(options) === 'function') {
      callback = options;
      options = null;
    }
    options = options || {};

    const role = options.role || 'member';

    const parameters = {
      id: this.id,
      username: username,
      role: role,
    };
    github.post(token, 'orgs.addTeamMembership', parameters, callback);
  }

  addMaintainer(username, callback) {
    const options = {
      role: 'maintainer',
    };
    this.addMembership(username, options, callback);
  }

  getMembership(username, options, callback) {
    const operations = _private(this).operations;
    const token = _private(this).getToken();
    if (!callback && typeof(options) === 'function') {
      callback = options;
      options = null;
    }
    options = options || {};
    if (!options.maxAgeSeconds) {
      options.maxAgeSeconds = operations.defaults.orgMembershipDirectStaleSeconds;
    }
    // If a background refresh setting is not present, perform a live
    // lookup with this call. This is the opposite of most of the library's
    // general behavior.
    if (options.backgroundRefresh === undefined) {
      options.backgroundRefresh = false;
    }
    const parameters = {
      id: this.id,
      username: username,
    };
    return operations.github.call(token, 'orgs.getTeamMembership', parameters, (error, result) => {
      if (error.code === 404) {
        result = false;
        error = null;
      }
      if (error) {
        return callback(wrapError(error, `Trouble retrieving the membership for "${username}" in team ${this.id}`));
      }
      return callback(null, result);
    });
  }

  getMembershipEfficiently(username, options, callback) {
    // Hybrid calls are used to check for membership. Since there is
    // often a relatively fresh cache available of all of the members
    // of a team, that data source is used first to avoid a unique
    // GitHub API call.
    const operations = _private(this).operations;
    const self = this;
    // A background cache is used that is slightly more aggressive
    // than the standard org members list to at least frontload a
    // refresh of the data.
    if (!callback && typeof(options) === 'function') {
      callback = options;
      options = null;
    }
    options = options || {};
    if (!options.maxAgeSeconds) {
      options.maxAgeSeconds = operations.defaults.orgMembershipStaleSeconds;
    }
    self.isMaintainer(username, options, (getMaintainerError, isMaintainer) => {
      if (getMaintainerError) {
        return callback(getMaintainerError);
      }
      if (isMaintainer) {
        return callback(null, 'maintainer');
      }
      self.isMember(username, 'member', options, (getError, isMember) => {
        if (getError) {
          return callback(getError);
        }
        if (isMember) {
          return callback(null, 'member');
        }
        // Fallback to the standard membership lookup
        const membershipOptions = {
          maxAgeSeconds: operations.defaults.orgMembershipDirectStaleSeconds,
        };
        self.getMembership(username, membershipOptions, (getMembershipError, result) => {
          if (getMembershipError) {
            return callback(getMembershipError);
          }
          return callback(null, result.role);
        });
      });
    });
  }

  isMaintainer(username, options, callback) {
    return this.isMember(username, 'maintainer', options, callback);
  }

  isMember(username, role, options, callback) {
    const operations = _private(this).operations;
    role = role || 'member';
    options = options || {};
    if (!options.maxAgeSeconds) {
      options.maxAgeSeconds = operations.defaults.orgMembershipStaleSeconds;
    }
    this.getMembers(Object.assign({ role: role }, options), (getMembersError, members) => {
      if (getMembersError) {
        return callback(getMembersError);
      }
      const expected = username.toLowerCase();
      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        if (member.login.toLowerCase() === expected) {
          return callback(null, role);
        }
      }
      return callback(null, false);
    });
  }

  getMaintainers(options, callback) {
    if (!callback && typeof (options) === 'function') {
      callback = options;
      options = null;
    }
    options = options || {};
    if (!options.maxAgeSeconds) {
      options.maxAgeSeconds = _private(this).operations.defaults.teamMaintainersStaleSeconds;
    }
    const getMemberOptions = Object.assign({
      role: 'maintainer',
    }, options);
    this.getMembers(getMemberOptions, callback);
  }

  getMembers(options, callback) {
    if (!callback && typeof (options) === 'function') {
      callback = options;
      options = null;
    }
    options = options || {};

    let privates = _private(this);
    let operations = privates.operations;
    let token = privates.getToken();
    let github = operations.github;

    let parameters = {
      id: this.id,
      per_page: 100,
    };
    const caching = {
      maxAgeSeconds: options.maxAgeSeconds || operations.defaults.orgMembersStaleSeconds,
      backgroundRefresh: true,
    };
    if (options && options.backgroundRefresh === false) {
      caching.backgroundRefresh = false;
    }
    if (options.role) {
      parameters.role = options.role;
    }
    if (options.pageLimit) {
      parameters.pageLimit = options.pageLimit;
    }
    return github.collections.getTeamMembers(
      token,
      parameters,
      caching,
      common.createInstancesCallback(this, this.memberFromEntity, callback));
  }

  getRepositories(options, callback) {
    if (!callback && typeof (options) === 'function') {
      callback = options;
      options = null;
    }
    options = options || {};

    let privates = _private(this);
    let operations = privates.operations;
    let token = privates.getToken();
    let github = operations.github;

    const customTypeFilteringParameter = options.type;
    if (customTypeFilteringParameter && customTypeFilteringParameter !== 'sources') {
      return callback(new Error('Custom \'type\' parameter is specified, but at this time only \'sources\' is a valid enum value'));
    }

    let parameters = {
      id: this.id,
      per_page: 100,
    };
    const caching = {
      maxAgeSeconds: options.maxAgeSeconds || operations.defaults.orgMembersStaleSeconds,
      backgroundRefresh: true,
    };
    if (options && options.backgroundRefresh === false) {
      caching.backgroundRefresh = false;
    }
    if (options.pageLimit) {
      parameters.pageLimit = options.pageLimit;
    }
    return github.collections.getTeamRepos(
      token,
      parameters,
      caching,
      (getTeamReposError, entities) => {
        const commonCallback = common.createInstancesCallback(this, repositoryFromEntity, callback);
        if (customTypeFilteringParameter !== 'sources') {
          return commonCallback(null, entities);
        }
        // Remove forks (non-sources)
        _.remove(entities, repo => { return repo.fork; });
        return commonCallback(null, entities);
      });
  }

  member(id, optionalEntity) {
    let entity = optionalEntity || {};
    if (!optionalEntity) {
      entity.id = id;
    }
    const member = new TeamMember(
      this,
      entity,
      _private(this).getToken,
      _private(this).operations);
    // CONSIDER: Cache any members in the local instance
    return member;
  }

  memberFromEntity(entity) {
    return this.member(entity.id, entity);
  }
}

module.exports = Team;

function repositoryFromEntity(entity) {
  // private, remapped "this"
  const instance = new TeamRepositoryPermission(
    this,
    entity,
    _private(this).getToken,
    _private(this).operations);
  return instance;
}

const privateSymbol = Symbol();
function _private(self) {
  if (self[privateSymbol] === undefined) {
    self[privateSymbol] = {};
  }
  return self[privateSymbol];
}